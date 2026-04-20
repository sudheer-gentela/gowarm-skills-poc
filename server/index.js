// server/index.js
// GoWarm Skills Runner — deployable to Railway.
//
// Routes:
//   GET  /                                   -> serves the rep UI
//   GET  /api/deals/:id/context              -> proxies to GoWarm backend (falls back to mock/)
//   POST /api/skills/discovery-call-prep     -> runs the skill via Anthropic API
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

// Execute the Discovery Call Prep skill
app.post("/api/skills/discovery-call-prep", async (req, res) => {
  try {
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

    const userMessage = [
      "Execute the Discovery Call Prep skill on the following deal payload.",
      methodology
        ? `Apply the ${methodology.toUpperCase()} methodology lens as described in the methodologies/${methodology}.md file.`
        : "No methodology specified — run in default mode.",
      "Return ONLY the JSON object specified in the skill's Output format section.",
      "No prose, no markdown fences, no commentary.",
      "",
      "Deal payload:",
      "```json",
      JSON.stringify(dealPayload, null, 2),
      "```",
    ].join("\n");

    const startTs = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userMessage }],
    });
    const latencyMs = Date.now() - startTs;

    // ── Token tracking ──────────────────────────────────────
    const usageEntry = logUsage({
      skill: "discovery-call-prep",
      methodology,
      dealId: dealPayload?.deal?.id || null,
      model: response.model || MODEL,
      usage: response.usage,
      latencyMs,
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({
        error: "skill_output_not_valid_json",
        raw: text.slice(0, 2000),
        usage: usageEntry,
      });
    }

    res.json({
      ok: true,
      output: parsed,
      methodology: methodology || "default",
      usage: usageEntry,
      session_totals: getSessionTotals(),
    });
  } catch (err) {
    console.error("Skill execution failed:", err);
    res.status(500).json({ error: "skill_execution_failed", message: err.message });
  }
});

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
