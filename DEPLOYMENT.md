# Railway Deployment Guide

Deploy the GoWarm Skills Runner as a separate Railway service that talks to your existing GoWarm backend.

## Architecture

```
gowarmcrm.com  ──────► gowarm-backend (Railway, existing)
                           │
                           │  adds: GET /api/skill-context/deals/:id
                           │
                           ▼
               gowarm-skills-runner (Railway, NEW)
                           │
                           ▼
                   api.anthropic.com
```

The skill runner is its own Railway service. It does NOT share a database or deploy pipeline with your existing backend. It calls the backend over HTTPS using a shared service token.

---

## One-time setup

### 1. Add the skill-context route to your GoWarm backend

Copy `backend-patch/skill-context-route.js` into your backend repo (e.g. to `routes/skill-context.js`). Wire it up in your main `app.js` / `server.js`:

```js
const skillContext = require("./routes/skill-context");
app.use("/api/skill-context", skillContext);
```

Fill in the four data access functions (`getDealById`, `getProspectForDeal`, `getAccountForDeal`, `getInteractionHistory`, `getMeddpiccSnapshot`) with calls to your existing repositories/services. These should be read-only queries you almost certainly already have.

Add to your GoWarm backend Railway env vars:

```
SKILL_RUNNER_TOKEN=<generate a strong random string, e.g. `openssl rand -hex 32`>
```

Deploy the backend. Smoke test:

```bash
curl -H "x-skill-runner-token: $TOKEN" \
  https://<your-gowarm-backend>.up.railway.app/api/skill-context/deals/<real-deal-id>
```

You should get back the canonical payload. If anything looks wrong in the payload (missing fields, wrong names), fix it now before deploying the skill runner — the skill output quality is 100% downstream of this.

### 2. Push the skill runner to GitHub

```bash
cd gowarm-skills-poc
git init
git add .
git commit -m "Initial Skills Runner PoC"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

### 3. Create the Railway service

1. In Railway dashboard, **New Project → Deploy from GitHub repo**
2. Select the `gowarm-skills-poc` repo
3. Railway auto-detects Node via Nixpacks and reads `railway.json` for the start command and healthcheck

### 4. Set env vars in Railway

In the skill runner service's Variables tab:

| Variable              | Value                                                 | Required |
|-----------------------|-------------------------------------------------------|----------|
| `ANTHROPIC_API_KEY`   | `sk-ant-...` from console.anthropic.com               | yes      |
| `GOWARM_API_URL`      | `https://<your-gowarm-backend>.up.railway.app`        | yes      |
| `SKILL_RUNNER_TOKEN`  | Same value you set on the backend                     | yes      |
| `UI_ACCESS_TOKEN`     | A second random string for UI access control          | recommended |
| `NODE_ENV`            | `production`                                          | recommended |

The `PORT` variable is set by Railway automatically — don't override it.

### 5. Deploy and verify

Railway deploys automatically on push. Once it's up:

```bash
# Healthcheck
curl https://<your-skills-runner>.up.railway.app/health
# → {"ok":true,"mode":"production",...}

# Try the full flow
open "https://<your-skills-runner>.up.railway.app/?token=<UI_ACCESS_TOKEN>"
```

Enter a real GoWarm deal ID. If everything is wired correctly, you'll see the four output cards populated from live data.

---

## Troubleshooting

### "gowarm_backend_unreachable"
- Railway services are publicly reachable by default, so this should work out of the box over HTTPS.
- If you want to use Railway's private networking between services (more secure, no egress cost), set `GOWARM_API_URL` to `http://<backend-service-name>.railway.internal:<backend-port>` and make sure both services are in the same Railway project.

### "gowarm_backend_error" 401
- `SKILL_RUNNER_TOKEN` mismatch between the two services. Double-check both Railway env var panels.

### "skill_output_not_valid_json"
- Claude sometimes wraps JSON in markdown fences despite instructions. The server strips common fence patterns but may miss edge cases. Check the `raw` field in the response; if it's a recurring issue, tighten the "Output format" section in `SKILL.md`.

### "deal_not_found"
- In production mode the ID must match a real GoWarm deal. The `1-rich` / `2-sparse` IDs only work in mock mode (when `GOWARM_API_URL` is unset).

### The skill output is generic/bad
- This is almost always a payload problem, not a prompt problem. Hit your `/api/skill-context/deals/:id` endpoint directly and look at what's actually getting returned. Is `interaction_history` populated? Is the MEDDPICC object rich or mostly nulls?
- Iterate on the backend payload before touching `SKILL.md`.

---

## Cost notes

Each skill run is one Anthropic API call. Rough math with claude-sonnet-4-5:
- System prompt (SKILL.md + bundled files): ~5k tokens
- Deal payload + user message: ~1-2k tokens
- Response: ~2k tokens
- Total per call: ~8-9k tokens

At current Sonnet pricing, that's around 3-4 cents per prep. For early testing with a handful of reps, cost is negligible. At scale, enable prompt caching on the system prompt — the skill bundle doesn't change between runs, so caching reduces the effective cost dramatically.

---

## Rolling back

If something goes wrong, the skill runner is isolated — you can:

1. Delete the Railway service entirely (your backend and main product are unaffected)
2. Or disable the UI by unsetting `UI_ACCESS_TOKEN` and keeping the backend route dormant (it's read-only and token-gated)
3. Or remove the backend route — it's additive, nothing existing depends on it

---

## Next steps after a successful deploy

1. **Pick 3-5 real deals** in discovery_call stage and run the skill against each. Note specifically where the output is thin vs. sharp.
2. **Check whether the `interaction_history` is rich enough** — this is where most quality issues originate.
3. **Review the `confidence_notes` field** on sparse deals. If it's admitting what it doesn't know, guardrails are working. If it's inventing, tighten `SKILL.md`.
4. **Time the rep feedback loop**. Do reps actually use the output? That's the PMF test.
