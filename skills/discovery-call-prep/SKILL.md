---
name: discovery-call-prep
description: Generates pre-call preparation for a sales rep about to run a discovery call. Produces a prep brief, a talk track with discovery questions, two post-call follow-up email variants (strong signal and weak signal), and a recommended next step play. Use whenever a deal is entering or in the `discovery_call` stage, a rep explicitly requests call prep, or a prospect meeting is scheduled within the next 24 hours. Trigger this skill even if the rep just asks to "prep for a call" without naming the stage.
---

# Discovery Call Prep Skill

You are executing the Discovery Call Prep play from the GoWarmCRM Sales module. Your job is to turn a structured deal payload into four deliverables that the rep can act on immediately.

## When to use

- Deal stage is `discovery_call` or transitioning into it
- A scheduled meeting with the prospect is within 24 hours
- Rep explicitly requests pre-call preparation
- A rep is reviewing a deal that hasn't had a qualification call yet

## Required inputs

The caller passes a GoWarm deal payload. The expected shape is documented in `schema/gowarm-deal.json`. At minimum the payload must include:

- `prospect` — name, title, company, linkedin_url (optional)
- `account` — industry, size, revenue_band
- `deal` — stage, source, playbook_id, created_at, amount (optional)
- `interaction_history` — array of the last 10 touches (emails, calls, LinkedIn, meetings)
- `meddpicc` — object with known qualification data (may be sparse)

If required fields are missing, return a JSON error object with the shape `{ "error": "missing_fields", "missing": [...] }` rather than fabricating data.

## Execution steps

1. **Parse the payload.** Identify: engagement level (count and recency of interactions), time-in-stage, prior stated pains or objections, champion signals, and which MEDDPICC elements are filled vs. empty.

2. **Load the discovery question bank** from `reference/discovery-question-bank.md`. Select **6–8 questions** prioritized in this order:
   - Questions that fill the biggest MEDDPICC gaps in the payload
   - Questions tied to the prospect's industry (use the industry section if one exists)
   - Questions appropriate to the deal source (inbound vs. outbound calls for different openings)

3. **Consult the MEDDPICC reference** at `reference/meddpicc.md` if you need to reason about which qualification gaps matter most.

4. **Generate the prep brief** using the structure in `templates/prep-brief.md`. Keep it under 250 words. Lead with the single most important thing the rep should know walking in.

5. **Generate the talk track** using `templates/talk-track.md`. Structure: opening (30s) → context confirmation (2 min) → discovery questions (the 6–8 you selected) → close with a clear next step ask.

6. **Draft two follow-up email variants** using `templates/follow-up-email.md`:
   - `follow_up_email_strong` — the call went well, clear signal, moving forward
   - `follow_up_email_weak` — the call was tepid or non-committal, nurture mode
   Each must be under 120 words.

7. **Recommend the next play.** Based on the MEDDPICC picture after a good call, name the most likely next play from the Sales module playbook: `demo`, `multi_thread`, `technical_deep_dive`, `proposal`, `disqualify`, or `nurture`. Briefly justify.

## Output format

Return a single JSON object. Do NOT wrap in markdown fences. Do NOT include any prose before or after the JSON.

```
{
  "prep_brief": "...",
  "talk_track": {
    "opening": "...",
    "context_confirmation": "...",
    "discovery_questions": ["...", "..."],
    "close": "..."
  },
  "follow_up_email_strong": {
    "subject": "...",
    "body": "..."
  },
  "follow_up_email_weak": {
    "subject": "...",
    "body": "..."
  },
  "recommended_next_step": {
    "play": "demo" | "multi_thread" | "technical_deep_dive" | "proposal" | "disqualify" | "nurture",
    "rationale": "..."
  },
  "confidence_notes": "..."
}
```

## Guardrails

- Never invent facts about the prospect or account not present in the payload. If you don't know, say so in `confidence_notes`.
- If `interaction_history` has fewer than 2 entries, flag "sparse interaction history" in `confidence_notes`.
- Discovery questions must be open-ended. Reject any phrasing that invites a yes/no answer.
- Follow-up emails must be under 120 words each. No em-dashes. No phrases like "I hope this email finds you well."
- The prep brief should reference specific payload facts (by name, by date, by prior statement), not generic advice.
- If the MEDDPICC object is completely empty, weight discovery questions heavily toward Pain and Champion identification — those come first.
