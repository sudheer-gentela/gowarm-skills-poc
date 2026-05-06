// server/index.js
// GoWarm Skills Runner — deployable to Railway.
//
// Routes:
//   GET  /                                   -> serves the rep UI
//   GET  /api/deals/:id/context              -> proxies to GoWarm backend (falls back to mock/)
//   GET  /api/prospects/:id/context          -> proxies to GoWarm backend
//   POST /api/skills/discovery-call-prep     -> runs the skill via Anthropic API
//   POST /api/skills/outreach-personalization-> runs the skill via Anthropic API
//   GET  /api/skill-runs                     -> proxy: list logged runs
//   GET  /api/skill-runs/summary             -> proxy: hook distributions
//   GET  /api/skill-runs/:id                 -> proxy: full run detail
//   GET  /api/usage                          -> returns session token usage summary
//   GET  /health                             -> Railway healthcheck
//
// Required env vars:
//   ANTHROPIC_API_KEY      - Anthropic API key
//   GOWARM_API_URL         - Base URL of GoWarm backend (e.g. https://api.gowarmcrm.com)
//   SKILL_RUNNER_TOKEN     - Shared secret between this service and GoWarm backend
//
// Optional env vars:
//   PORT                   - set by Railway automatically
//   UI_ACCESS_TOKEN        - if set, UI requires ?token=... query param
//   NODE_ENV               - 'production' enables stricter behavior
//   SKILL_MODEL            - override Anthropic model (default: claude-sonnet-4-5)

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");

const app = express();
app.use(express.json({ limit: "1mb" }));

const ROOT = path.join(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, "skills");
const MOCK_DIR = path.join(ROOT, "mock");
const PUBLIC_DIR = path.join(ROOT, "public");

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === "production";
const GOWARM_API_URL = process.env.GOWARM_API_URL;
const SKILL_RUNNER_TOKEN = process.env.SKILL_RUNNER_TOKEN;
const UI_ACCESS_TOKEN = process.env.UI_ACCESS_TOKEN;
const MODEL = process.env.SKILL_MODEL || "claude-sonnet-4-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY is not set");
  process.exit(1);
}
if (IS_PROD && !GOWARM_API_URL) {
  console.warn("WARNING: GOWARM_API_URL not set in production — falling back to mock data");
}
if (GOWARM_API_URL && !SKILL_RUNNER_TOKEN) {
  console.error("FATAL: GOWARM_API_URL is set but SKILL_RUNNER_TOKEN is not");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------------------------------------------------------------------------
// Token tracking (PoC-local)
//
// Mirrors the shape of TokenTrackingService.log() in the main GoWarm backend.
// For the PoC we keep usage in-memory and also append to a JSONL log on disk.
// When this migrates into the main backend, swap these calls for
// TokenTrackingService.log({ orgId, userId, callType: 'skill_discovery_call_prep',
// model, usage, dealId }).
// ---------------------------------------------------------------------------

// Per-token USD cost by model family, kept aligned with TokenTrackingService.js
// in the main backend. Update both when Anthropic changes pricing.
const MODEL_COSTS = {
  "claude-haiku":  { input: 0.0000008, output: 0.000004 },
  "claude-sonnet": { input: 0.000003,  output: 0.000015 },
  "claude-opus":   { input: 0.000015,  output: 0.000075 },
};

function estimateCost(model, inputTokens, outputTokens) {
  if (!model) return 0;
  const lower = model.toLowerCase();
  let costs = MODEL_COSTS["claude-sonnet"];
  if (lower.includes("haiku")) costs = MODEL_COSTS["claude-haiku"];
  else if (lower.includes("opus")) costs = MODEL_COSTS["claude-opus"];
  return parseFloat(((inputTokens * costs.input) + (outputTokens * costs.output)).toFixed(6));
}

// In-memory session usage log. Resets on service restart.
const usageLog = [];

function logUsage({ skill, methodology, dealId, model, usage, latencyMs }) {
  const inputTokens  = usage?.input_tokens  || 0;
  const outputTokens = usage?.output_tokens || 0;
  const cacheCreationTokens = usage?.cache_creation_input_tokens || 0;
  const cacheReadTokens     = usage?.cache_read_input_tokens || 0;
  const totalTokens = inputTokens + outputTokens;
  const cost = estimateCost(model, inputTokens, outputTokens);

  const entry = {
    timestamp: new Date().toISOString(),
    skill, methodology: methodology || "default",
    dealId: dealId || null,
    model,
    input_tokens:  inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens:     cacheReadTokens,
    total_tokens:  totalTokens,
    estimated_cost_usd: cost,
    latency_ms: latencyMs || null,
  };
  usageLog.push(entry);
  // Keep the log bounded in memory
  if (usageLog.length > 500) usageLog.shift();
  return entry;
}

function getSessionTotals() {
  const totals = {
    call_count: usageLog.length,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
    by_methodology: {},
  };
  for (const e of usageLog) {
    totals.input_tokens  += e.input_tokens;
    totals.output_tokens += e.output_tokens;
    totals.total_tokens  += e.total_tokens;
    totals.estimated_cost_usd += e.estimated_cost_usd;
    const m = e.methodology || "default";
    if (!totals.by_methodology[m]) {
      totals.by_methodology[m] = { call_count: 0, total_tokens: 0, estimated_cost_usd: 0 };
    }
    totals.by_methodology[m].call_count++;
    totals.by_methodology[m].total_tokens += e.total_tokens;
    totals.by_methodology[m].estimated_cost_usd += e.estimated_cost_usd;
  }
  totals.estimated_cost_usd = parseFloat(totals.estimated_cost_usd.toFixed(6));
  return totals;
}

// ---------------------------------------------------------------------------
// Skill-run recording (instrumentation)
//
// After each skill execution we POST the full input + output to the GoWarm
// backend's /api/skill-runs route. This is fire-and-forget — failures log
// but never block the user's response.
//
// The assembled system prompt is large and rarely changes. We send the
// prompt text only once per content-hash; subsequent runs send hash-only
// and the backend reuses the existing skill_prompt_versions row.
// ---------------------------------------------------------------------------

// In-memory cache of prompt hashes we've already sent text for. Resets on
// service restart, which means after every redeploy we re-send the prompt
// text once. That's harmless — the backend's INSERT uses ON CONFLICT DO NOTHING.
const promptTextSentHashes = new Set();

function hashPrompt(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// Pull org_id, prospect_id, rep_user_id from the canonical payload's _meta
// block (added by SkillContextService). Returns nulls if absent — we still
// log the run, just without attribution.
function extractMeta(payload) {
  const m = payload && payload._meta;
  if (!m || typeof m !== "object") return { org_id: null, prospect_id: null, rep_user_id: null };
  return {
    org_id:      m.org_id      ?? null,
    prospect_id: m.prospect_id ?? null,
    rep_user_id: m.rep_user_id ?? null,
  };
}

// Fire-and-forget POST. Always returns void. Errors are logged.
async function recordSkillRun({
  skillName,
  inputPayload,
  systemPrompt,
  output,
  rawOutput,
  methodology,
  model,
  usage,
  latencyMs,
  status,
  errorDetail,
  dealId,    // for deal-side skills, pass through directly
}) {
  if (!GOWARM_API_URL || !SKILL_RUNNER_TOKEN) {
    // No backend configured — silently skip. Mock-only mode.
    return;
  }

  try {
    const meta = extractMeta(inputPayload);
    // For deal-side skills the meta block isn't present; org_id has to come
    // from somewhere. The deal payload has a top-level account.id on some
    // shapes but not the org. For now, deal runs without meta are skipped
    // with a warning — instrumentation for the deal route lights up once
    // the deal-side route is rewritten to include _meta (backlog item 3).
    if (meta.org_id == null) {
      console.warn(`[skill-run] no _meta.org_id in ${skillName} payload; skipping log`);
      return;
    }

    const promptHash = hashPrompt(systemPrompt);
    const sendPromptText = !promptTextSentHashes.has(promptHash);

    const body = {
      org_id:        meta.org_id,
      user_id:       meta.rep_user_id,
      skill_name:    skillName,
      prospect_id:   meta.prospect_id,
      deal_id:       dealId || null,
      input_payload: inputPayload,
      output:        output,
      raw_output:    rawOutput,
      prompt_hash:   promptHash,
      prompt_text:   sendPromptText ? systemPrompt : undefined,
      methodology:   methodology || null,
      model,
      input_tokens:  usage?.input_tokens  || 0,
      output_tokens: usage?.output_tokens || 0,
      cost_usd:      estimateCost(model, usage?.input_tokens || 0, usage?.output_tokens || 0),
      latency_ms:    latencyMs || null,
      status,
      error_detail:  errorDetail || null,
    };

    const url = `${GOWARM_API_URL.replace(/\/$/, "")}/api/skill-runs`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":         "application/json",
        "Accept":               "application/json",
        "x-skill-runner-token": SKILL_RUNNER_TOKEN,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`[skill-run] backend rejected log: ${resp.status} ${errText.slice(0, 200)}`);
      return;
    }

    // Mark the hash as sent only after a successful POST. If the request
    // failed, the next run for the same prompt will re-attempt sending
    // the text.
    if (sendPromptText) promptTextSentHashes.add(promptHash);
  } catch (err) {
    console.error(`[skill-run] log failed for ${skillName}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Robust JSON extraction
//
// Models occasionally wrap output in markdown fences, add a ``` close tag
// followed by stray characters, or emit unescaped double quotes inside string
// values (e.g. when quoting a prospect's post verbatim). We cover the cheap
// recoverable cases here so transient emission glitches don't blow up the
// response. Anything we cannot recover from still surfaces a 500 with the raw
// text for inspection.
//
// Returns { ok: true, value } or { ok: false, error, attempted }.
// `attempted` is the cleaned-but-still-failing string so the caller can put
// it on the error response for debugging.
// ---------------------------------------------------------------------------
function extractJsonObject(rawText) {
  if (typeof rawText !== "string" || rawText.trim() === "") {
    return { ok: false, error: "empty_response", attempted: "" };
  }

  // Strip leading prose, code fences, and trailing fences/ellipsis.
  let s = rawText.trim();

  // Remove an opening ```json or ``` fence (with or without language tag).
  s = s.replace(/^```(?:json|JSON)?\s*\n?/i, "");
  // Remove a trailing closing fence and anything after it on the same line.
  s = s.replace(/\n?```[^\n]*$/i, "").trim();

  // Walk to the first '{' and from there to the last '}', so leading or
  // trailing prose (including stray "..." continuations) is dropped.
  const firstBrace = s.indexOf("{");
  const lastBrace  = s.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }

  // Attempt 1: parse as-is.
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (_) { /* fall through to recovery */ }

  // Attempt 2: repair unescaped double quotes inside string values.
  //
  // The most common LLM JSON failure is: "body": "He said "hi" today"
  // We walk the string character by character respecting structural quotes,
  // and inside a string-value, any " that isn't followed by a valid
  // string-terminator character (whitespace, comma, } , ], :, or end) gets
  // backslash-escaped. This is a heuristic but it handles the case in the
  // raw output we've been seeing without breaking already-valid JSON.
  const repaired = repairUnescapedQuotes(s);
  if (repaired !== s) {
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch (_) { /* fall through */ }
  }

  return { ok: false, error: "unparseable_after_repair", attempted: s };
}

// Heuristic repair for the common "embedded unescaped double quote" case.
// Scans the string keeping track of whether we're inside a string value,
// and only escapes a `"` if it's followed by a non-terminator character.
function repairUnescapedQuotes(s) {
  let out = "";
  let inString = false;
  let prev = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && prev !== "\\") {
      if (!inString) {
        // Opening quote of a string.
        inString = true;
        out += ch;
      } else {
        // We're inside a string. Decide whether this `"` ends the string
        // or is a stray embedded quote that needs escaping.
        // Look at the next non-space character.
        let j = i + 1;
        while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
        const next = j < s.length ? s[j] : "";
        const terminators = [",", "}", "]", ":", "\n", "\r", ""];
        if (terminators.includes(next)) {
          inString = false;
          out += ch;
        } else {
          // Stray embedded quote — escape it.
          out += '\\"';
        }
      }
    } else {
      out += ch;
    }
    prev = ch;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Healthcheck — before access gate so Railway can hit it
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mode: GOWARM_API_URL ? "production" : "mock",
    model: MODEL,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// UI access gate
// ---------------------------------------------------------------------------
function uiAccessGate(req, res, next) {
  if (!UI_ACCESS_TOKEN) return next();
  if (req.path === "/health") return next();

  const cookieHeader = req.headers.cookie || "";
  const cookieMatch = cookieHeader.split(";").map(s => s.trim()).find(s => s.startsWith("ui_token="));
  const cookieValue = cookieMatch ? cookieMatch.split("=")[1] : null;

  if (req.query.token === UI_ACCESS_TOKEN) {
    res.setHeader("Set-Cookie",
      `ui_token=${UI_ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    return next();
  }
  if (cookieValue === UI_ACCESS_TOKEN) return next();

  res.status(401).send("Unauthorized — append ?token=... to the URL to access.");
}

app.use(uiAccessGate);
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Skill loader — now accepts a methodology parameter
// ---------------------------------------------------------------------------

const ALLOWED_METHODOLOGIES = new Set(["meddic", "challenger"]);

function loadSkill(skillName, methodology) {
  const skillRoot = path.join(SKILLS_DIR, skillName);
  const skillMd = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const bundle = { skillMd, methodology: methodology || null, files: {} };

  const subdirs = ["templates", "reference", "schema"];
  for (const sub of subdirs) {
    const subPath = path.join(skillRoot, sub);
    if (!fs.existsSync(subPath)) continue;
    for (const file of fs.readdirSync(subPath)) {
      const rel = path.join(sub, file);
      bundle.files[rel] = fs.readFileSync(path.join(subPath, file), "utf8");
    }
  }

  // Add methodology file only if requested and valid
  if (methodology && ALLOWED_METHODOLOGIES.has(methodology)) {
    const methodologyPath = path.join(skillRoot, "methodologies", `${methodology}.md`);
    if (fs.existsSync(methodologyPath)) {
      const rel = path.join("methodologies", `${methodology}.md`);
      bundle.files[rel] = fs.readFileSync(methodologyPath, "utf8");
    } else {
      console.warn(`Methodology file not found: ${methodologyPath}`);
    }
  }

  return bundle;
}

function buildSystemPrompt(bundle) {
  let prompt = bundle.skillMd + "\n\n## Bundled skill files\n\n";
  prompt += "The following files are referenced by SKILL.md. Use them as instructed.\n\n";

  if (bundle.methodology) {
    prompt += `## Active methodology: ${bundle.methodology.toUpperCase()}\n\n`;
    prompt += `A methodology file is included below at \`methodologies/${bundle.methodology}.md\`. Its guidance shapes the tone, question selection, email framing, close, and next-step recommendation for this run. Base guardrails (no hallucination, placeholder usage in emails, no leaking system context) still apply universally.\n\n`;
  }

  for (const [rel, contents] of Object.entries(bundle.files)) {
    prompt += `### FILE: ${rel}\n\n\`\`\`\n${contents}\n\`\`\`\n\n`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/deals/:id/context", async (req, res) => {
  const { id } = req.params;

  if (!GOWARM_API_URL) {
    const mockFile = path.join(MOCK_DIR, `deal-${id}.json`);
    if (!fs.existsSync(mockFile)) {
      return res.status(404).json({ error: "deal_not_found", id });
    }
    return res.json(JSON.parse(fs.readFileSync(mockFile, "utf8")));
  }

  try {
    const url = `${GOWARM_API_URL.replace(/\/$/, "")}/api/skill-context/deals/${encodeURIComponent(id)}`;
    const response = await fetch(url, {
      headers: {
        "x-skill-runner-token": SKILL_RUNNER_TOKEN,
        "Accept": "application/json",
      },
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return res.status(response.status).json({
        error: "gowarm_backend_error",
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }
    res.json(await response.json());
  } catch (err) {
    console.error("GoWarm backend fetch failed:", err);
    res.status(502).json({ error: "gowarm_backend_unreachable", message: err.message });
  }
});

// Prospect context — proxy-only (no PoC mocks). Phase 1.5 onward, GoWarm
// owns prospect data via /api/skill-context/prospects/:id.
// Optional ?as_user=:userId to apply per-user prospecting_config overrides.
app.get("/api/prospects/:id/context", async (req, res) => {
  const { id } = req.params;
  const asUser = req.query.as_user;

  if (!GOWARM_API_URL) {
    return res.status(500).json({
      error: "gowarm_backend_not_configured",
      hint: "Set GOWARM_API_URL env var to point at the GoWarm backend.",
    });
  }

  try {
    let url = `${GOWARM_API_URL.replace(/\/$/, "")}/api/skill-context/prospects/${encodeURIComponent(id)}`;
    if (asUser) {
      url += `?as_user=${encodeURIComponent(asUser)}`;
    }
    const response = await fetch(url, {
      headers: {
        "x-skill-runner-token": SKILL_RUNNER_TOKEN,
        "Accept": "application/json",
      },
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      return res.status(response.status).json({
        error: "gowarm_backend_error",
        status: response.status,
        detail: errText.slice(0, 500),
      });
    }
    res.json(await response.json());
  } catch (err) {
    console.error("GoWarm backend fetch failed:", err);
    res.status(502).json({ error: "gowarm_backend_unreachable", message: err.message });
  }
});

// Execute the Discovery Call Prep skill
app.post("/api/skills/discovery-call-prep", async (req, res) => {
  const dealPayload = req.body && req.body.dealPayload;
  const methodology = req.body && req.body.methodology;

  if (!dealPayload) {
    return res.status(400).json({ error: "missing_deal_payload" });
  }
  if (methodology && !ALLOWED_METHODOLOGIES.has(methodology)) {
    return res.status(400).json({
      error: "invalid_methodology",
      allowed: Array.from(ALLOWED_METHODOLOGIES),
    });
  }

  const bundle = loadSkill("discovery-call-prep", methodology);
  const system = buildSystemPrompt(bundle);
  const dealId = dealPayload?.deal?.id || null;

  const userMessage = [
    "Execute the Discovery Call Prep skill on the following deal payload.",
    methodology
      ? `Apply the ${methodology.toUpperCase()} methodology lens as described in the methodologies/${methodology}.md file.`
      : "No methodology specified — run in default mode.",
    "Return ONLY the JSON object specified in the skill's Output format section.",
    "No prose, no markdown fences, no commentary.",
    "Inside JSON string values, every double-quote character must be escaped as \\\".",
    "",
    "Deal payload:",
    "```json",
    JSON.stringify(dealPayload, null, 2),
    "```",
  ].join("\n");

  const startTs = Date.now();
  let response, latencyMs, completeText, parseResult, usageEntry;

  try {
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: "{" },
      ],
    });
    latencyMs = Date.now() - startTs;

    usageEntry = logUsage({
      skill: "discovery-call-prep",
      methodology,
      dealId,
      model: response.model || MODEL,
      usage: response.usage,
      latencyMs,
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    completeText = "{" + text;
    parseResult = extractJsonObject(completeText);
  } catch (err) {
    console.error("Skill execution failed:", err);
    recordSkillRun({
      skillName:    "discovery-call-prep",
      inputPayload: dealPayload,
      systemPrompt: system,
      output:       null,
      rawOutput:    null,
      methodology:  methodology || null,
      model:        MODEL,
      usage:        { input_tokens: 0, output_tokens: 0 },
      latencyMs:    Date.now() - startTs,
      status:       "execution_failed",
      errorDetail:  err.message,
      dealId,
    }).catch(() => {});
    return res.status(500).json({ error: "skill_execution_failed", message: err.message });
  }

  if (!parseResult.ok) {
    recordSkillRun({
      skillName:    "discovery-call-prep",
      inputPayload: dealPayload,
      systemPrompt: system,
      output:       null,
      rawOutput:    completeText,
      methodology:  methodology || null,
      model:        response.model || MODEL,
      usage:        response.usage,
      latencyMs,
      status:       "parse_failed",
      errorDetail:  parseResult.error,
      dealId,
    }).catch(() => {});
    return res.status(500).json({
      error: "skill_output_not_valid_json",
      reason: parseResult.error,
      raw: completeText.slice(0, 2000),
      attempted: parseResult.attempted ? parseResult.attempted.slice(0, 2000) : null,
      usage: usageEntry,
    });
  }

  recordSkillRun({
    skillName:    "discovery-call-prep",
    inputPayload: dealPayload,
    systemPrompt: system,
    output:       parseResult.value,
    rawOutput:    completeText,
    methodology:  methodology || null,
    model:        response.model || MODEL,
    usage:        response.usage,
    latencyMs,
    status:       "ok",
    dealId,
  }).catch(() => {});

  res.json({
    ok: true,
    output: parseResult.value,
    methodology: methodology || "default",
    usage: usageEntry,
    session_totals: getSessionTotals(),
  });
});

// Execute the Outreach Personalization skill
app.post("/api/skills/outreach-personalization", async (req, res) => {
  const prospectPayload = req.body && req.body.prospectPayload;

  if (!prospectPayload) {
    return res.status(400).json({ error: "missing_prospect_payload" });
  }

  const bundle = loadSkill("outreach-personalization", null);
  const system = buildSystemPrompt(bundle);

  const userMessage = [
    "Execute the Outreach Personalization skill on the following prospect payload.",
    "Return ONLY the JSON object specified in the skill's Output format section.",
    "No prose, no markdown fences, no commentary.",
    "Inside JSON string values, every double-quote character must be escaped as \\\".",
    "",
    "Prospect payload:",
    "```json",
    JSON.stringify(prospectPayload, null, 2),
    "```",
  ].join("\n");

  const startTs = Date.now();
  let response, latencyMs, completeText, parseResult, usageEntry;

  try {
    // Prefill the assistant turn with `{` so the model is mechanically
    // forced to begin its response with a JSON object — no fences, no
    // preamble. We re-prepend `{` to the response text before parsing.
    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system,
      messages: [
        { role: "user", content: userMessage },
        { role: "assistant", content: "{" },
      ],
    });
    latencyMs = Date.now() - startTs;

    usageEntry = logUsage({
      skill: "outreach-personalization",
      methodology: null,
      dealId: null,
      model: response.model || MODEL,
      usage: response.usage,
      latencyMs,
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    // Re-attach the prefill character so the response is a complete JSON object.
    completeText = "{" + text;
    parseResult = extractJsonObject(completeText);
  } catch (err) {
    console.error("Skill execution failed:", err);
    // Log the execution failure (no usage data — the call never completed)
    recordSkillRun({
      skillName:    "outreach-personalization",
      inputPayload: prospectPayload,
      systemPrompt: system,
      output:       null,
      rawOutput:    null,
      methodology:  null,
      model:        MODEL,
      usage:        { input_tokens: 0, output_tokens: 0 },
      latencyMs:    Date.now() - startTs,
      status:       "execution_failed",
      errorDetail:  err.message,
    }).catch(() => {});
    return res.status(500).json({ error: "skill_execution_failed", message: err.message });
  }

  if (!parseResult.ok) {
    // Log the parse failure with the raw output so we can debug
    recordSkillRun({
      skillName:    "outreach-personalization",
      inputPayload: prospectPayload,
      systemPrompt: system,
      output:       null,
      rawOutput:    completeText,
      methodology:  null,
      model:        response.model || MODEL,
      usage:        response.usage,
      latencyMs,
      status:       "parse_failed",
      errorDetail:  parseResult.error,
    }).catch(() => {});
    return res.status(500).json({
      error: "skill_output_not_valid_json",
      reason: parseResult.error,
      raw: completeText.slice(0, 2000),
      attempted: parseResult.attempted ? parseResult.attempted.slice(0, 2000) : null,
      usage: usageEntry,
    });
  }

  // Success — fire-and-forget log, then respond
  recordSkillRun({
    skillName:    "outreach-personalization",
    inputPayload: prospectPayload,
    systemPrompt: system,
    output:       parseResult.value,
    rawOutput:    completeText,
    methodology:  null,
    model:        response.model || MODEL,
    usage:        response.usage,
    latencyMs,
    status:       "ok",
  }).catch(() => {});

  res.json({
    ok: true,
    output: parseResult.value,
    usage: usageEntry,
    session_totals: getSessionTotals(),
  });
});

// ---------------------------------------------------------------------------
// Skill-runs proxy routes
//
// The runner UI ("Runs" tab) calls these to read instrumentation data from
// the GoWarm backend. We proxy with the runner token so the UI doesn't need
// its own credential.
//
// All four take org_id as a required query param. The PoC UI typically
// hardcodes this from the operator's known org; in production this would
// come from the user's JWT.
// ---------------------------------------------------------------------------
function buildRunsBackendUrl(req, suffix = "") {
  const url = new URL(`${GOWARM_API_URL.replace(/\/$/, "")}/api/skill-runs${suffix}`);
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v != null && v !== "") url.searchParams.set(k, v);
  }
  return url.toString();
}

async function proxyToRunsBackend(req, res, suffix = "") {
  if (!GOWARM_API_URL) {
    return res.status(500).json({ error: "gowarm_backend_not_configured" });
  }
  try {
    const url = buildRunsBackendUrl(req, suffix);
    const resp = await fetch(url, {
      headers: {
        "x-skill-runner-token": SKILL_RUNNER_TOKEN,
        "Accept": "application/json",
      },
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      return res.status(resp.status).json({
        error: "gowarm_backend_error",
        status: resp.status,
        detail: errText.slice(0, 500),
      });
    }
    res.json(await resp.json());
  } catch (err) {
    console.error("skill-runs proxy failed:", err);
    res.status(502).json({ error: "gowarm_backend_unreachable", message: err.message });
  }
}

app.get("/api/skill-runs",         (req, res) => proxyToRunsBackend(req, res, ""));
app.get("/api/skill-runs/summary", (req, res) => proxyToRunsBackend(req, res, "/summary"));
app.get("/api/skill-runs/:id",     (req, res) => proxyToRunsBackend(req, res, `/${encodeURIComponent(req.params.id)}`));

// Return current session usage
app.get("/api/usage", (req, res) => {
  res.json({
    session_totals: getSessionTotals(),
    recent_calls: usageLog.slice(-20).reverse(), // last 20, newest first
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GoWarm Skills Runner listening on port ${PORT}`);
  console.log(`Mode: ${GOWARM_API_URL ? "production (live GoWarm API)" : "mock data"}`);
  console.log(`Model: ${MODEL}`);
});
