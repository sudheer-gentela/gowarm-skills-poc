# GoWarm Skills PoC — Discovery Call Prep

A minimal proof-of-concept that wraps the GoWarmCRM "Discovery Call" play as an Anthropic-style skill, runs it against a mock deal payload, and renders the output in a rep-facing web page.

This PoC does NOT touch your production backend. It consumes a deal payload (real or mocked) and runs the skill client-side of your core system. If this loop feels right, the follow-up work is folding skill execution into GoWarmCRM itself.

## What's inside

```
gowarm-skills-poc/
├── skills/
│   └── discovery-call-prep/
│       ├── SKILL.md                   ← the contract: when + how
│       ├── templates/                 ← output structure (brief, talk track, email)
│       ├── reference/                 ← MEDDPICC + discovery question bank
│       └── schema/                    ← expected deal payload shape
├── server/index.js                    ← Express: 2 routes + static
├── public/index.html                  ← rep UI, 4 output cards
├── mock/
│   ├── deal-1-rich.json               ← SaaS inbound, most MEDDPICC filled
│   └── deal-2-sparse.json             ← cold outbound, everything empty
└── package.json
```

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Set your Anthropic API key:

   ```bash
   export ANTHROPIC_API_KEY="sk-ant-..."
   ```

3. Start the server:

   ```bash
   npm start
   ```

4. Open http://localhost:3000

## How the flow works

```
Rep picks a deal from the dropdown
       ↓
GET /api/deals/:id/context           ← returns mocked deal payload
       ↓
POST /api/skills/discovery-call-prep  ← loads SKILL.md + bundles files
       ↓                                calls Anthropic /v1/messages
       ↓
Returns structured JSON
       ↓
UI renders 4 cards:
   Prep Brief | Talk Track | Follow-up Email (strong/weak tabs) | Next Step
```

## What to look for when evaluating

1. **Does the rich deal output reference Priya's specific stated pain** ("30% forecast error reduction by Q2") and her company's **Series C / new CRO** signals? If not, the prompt or schema needs tightening.

2. **Does the sparse deal** (Marcus at Verdant) produce output that **admits what it doesn't know** in `confidence_notes`, rather than inventing a champion or pain? This is the guardrail test.

3. **Are discovery questions open-ended?** A yes/no question slipping through means the guardrail isn't working.

4. **Is the strong-signal email meaningfully different from the weak-signal one?** If they feel generic/interchangeable, the template rules need more teeth.

5. **Does the recommended next step match the picture?** For Priya (strong inbound, stated pain, budget implied), you'd expect `demo` or `multi_thread`. For Marcus (nothing known), you'd expect `nurture` or careful re-discovery.

## Wiring to real GoWarm data

One change in `server/index.js`:

```js
// Replace the mock-file read in GET /api/deals/:id/context with:
const gowarmResp = await fetch(`${process.env.GOWARM_API}/api/deals/${id}/context`, {
  headers: { Authorization: `Bearer ${process.env.GOWARM_TOKEN}` }
});
const payload = await gowarmResp.json();
res.json(payload);
```

Your existing `/api/deals/:id/context` endpoint (or whatever you name it) needs to return the payload in the semantic shape defined by `skills/discovery-call-prep/schema/gowarm-deal.json`. The key contract point: the payload uses canonical field names (`deal.champion`, `meddpicc.identified_pain`), not raw Salesforce custom field IDs. Your `field_map` resolution runs on GoWarm's side, before the skill ever sees the data.

## Scaling beyond this skill

When you're ready to add the second play, the pattern is:

1. Create `skills/<play-name>/SKILL.md` with its own trigger description and execution steps.
2. Reuse the `reference/meddpicc.md` and `reference/discovery-question-bank.md` files by symlink or shared directory — most plays will share the same framework.
3. At around skill #5, replace the pre-bundle approach in `buildSystemPrompt()` with a `read_skill_file` tool that Claude calls to pull only the files it needs. Right now we dump everything into the system prompt, which is simple but won't scale.

## Open questions the PoC will surface

- **Schema coverage.** Running real deals will immediately show which fields are thin (meddpicc almost always is). That tells you what `field_map` and your aggregation layer need to cover next.
- **Output validation.** Right now we trust Claude's JSON. For production, add a schema validator and retry-on-failure logic.
- **Cost.** Each skill run is a single API call with a ~5k token system prompt. At scale you'll want caching — particularly prompt caching on the skill bundle, which Anthropic supports.
- **Tenant customization.** Customers will want to edit the question bank or the email tone. That's where the "playbook editor" story lives — customers fork skills per org.
