// server/index.js
// GoWarm Skills Runner — deployable to Railway.
//
// Routes:
//   GET  /                              -> serves the rep UI
//   GET  /api/deals/:id/context         -> proxies to GoWarm backend
//                                          (falls back to mock/ if GOWARM_API_URL unset)
//   POST /api/skills/discovery-call-prep -> runs the skill via Anthropic API
//   GET  /health                         -> Railway healthcheck
//
// Required env vars:
//   ANTHROPIC_API_KEY      - Anthropic API key
//   GOWARM_API_URL         - Base URL of your GoWarm backend (e.g. https://gowarm-backend.up.railway.app)
//   SKILL_RUNNER_TOKEN     - Shared secret between this service and GoWarm backend
//
// Optional env vars:
//   PORT                   - Railway sets this automatically
//   UI_ACCESS_TOKEN        - If set, UI requires ?token=... query param (basic access control)
//   NODE_ENV               - 'production' enables stricter behavior

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
// Config validation (fail fast at boot if production env is misconfigured)
// ---------------------------------------------------------------------------
const IS_PROD = process.env.NODE_ENV === "production";
const GOWARM_API_URL = process.env.GOWARM_API_URL;
const SKILL_RUNNER_TOKEN = process.env.SKILL_RUNNER_TOKEN;
const UI_ACCESS_TOKEN = process.env.UI_ACCESS_TOKEN;

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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ---------------------------------------------------------------------------
// Healthcheck (before the access gate so Railway can hit it)
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    mode: GOWARM_API_URL ? "production" : "mock",
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Optional UI access gate
// ---------------------------------------------------------------------------
// Keeps the rep UI behind a shared-secret token so the Railway URL
// isn't fully open. Visit once with ?token=... and a cookie is set.
function uiAccessGate(req, res, next) {
  if (!UI_ACCESS_TOKEN) return next();
  if (req.path === "/health") return next();

  const cookieHeader = req.headers.cookie || "";
  const cookieMatch = cookieHeader.split(";").map(s => s.trim()).find(s => s.startsWith("ui_token="));
  const cookieValue = cookieMatch ? cookieMatch.split("=")[1] : null;

  if (req.query.token === UI_ACCESS_TOKEN) {
    res.setHeader(
      "Set-Cookie",
      `ui_token=${UI_ACCESS_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
    );
    return next();
  }
  if (cookieValue === UI_ACCESS_TOKEN) return next();

  res.status(401).send("Unauthorized — append ?token=... to the URL to access.");
}

app.use(uiAccessGate);
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// Skill loader
// ---------------------------------------------------------------------------
function loadSkill(skillName) {
  const skillRoot = path.join(SKILLS_DIR, skillName);
  const skillMd = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const bundle = { skillMd, files: {} };
  const subdirs = ["templates", "reference", "schema"];
  for (const sub of subdirs) {
    const subPath = path.join(skillRoot, sub);
    if (!fs.existsSync(subPath)) continue;
    for (const file of fs.readdirSync(subPath)) {
      const full = path.join(subPath, file);
      const rel = path.join(sub, file);
      bundle.files[rel] = fs.readFileSync(full, "utf8");
    }
  }
  return bundle;
}

function buildSystemPrompt(bundle) {
  let prompt = bundle.skillMd + "\n\n## Bundled skill files\n\n";
  prompt += "The following files are referenced by SKILL.md. Use them as instructed.\n\n";
  for (const [rel, contents] of Object.entries(bundle.files)) {
    prompt += `### FILE: ${rel}\n\n\`\`\`\n${contents}\n\`\`\`\n\n`;
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Fetch deal payload. Production: hits GoWarm backend. Dev: reads mock file.
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
    const payload = await response.json();
    res.json(payload);
  } catch (err) {
    console.error("GoWarm backend fetch failed:", err);
    res.status(502).json({ error: "gowarm_backend_unreachable", message: err.message });
  }
});

// Execute the Discovery Call Prep skill
app.post("/api/skills/discovery-call-prep", async (req, res) => {
  try {
    const dealPayload = req.body && req.body.dealPayload;
    if (!dealPayload) {
      return res.status(400).json({ error: "missing_deal_payload" });
    }

    const bundle = loadSkill("discovery-call-prep");
    const system = buildSystemPrompt(bundle);

    const userMessage = [
      "Execute the Discovery Call Prep skill on the following deal payload.",
      "Return ONLY the JSON object specified in the skill's Output format section.",
      "No prose, no markdown fences, no commentary.",
      "",
      "Deal payload:",
      "```json",
      JSON.stringify(dealPayload, null, 2),
      "```",
    ].join("\n");

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4000,
      system,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = response.content
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n")
      .trim();

    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({
        error: "skill_output_not_valid_json",
        raw: text.slice(0, 2000),
      });
    }

    res.json({ ok: true, output: parsed });
  } catch (err) {
    console.error("Skill execution failed:", err);
    res.status(500).json({ error: "skill_execution_failed", message: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GoWarm Skills Runner listening on port ${PORT}`);
  console.log(`Mode: ${GOWARM_API_URL ? "production (live GoWarm API)" : "mock data"}`);
});
