# Launch Calendar Agent — README

## What this is
Next.js app with a conversational intake/update agent for the Launch Calendar, plus a
dashboard (a Launches table and a Portfolio Health view). Storage is Supabase (Postgres).
OpenAI's `gpt-4o-mini` handles natural-language extraction and the two executive
write-ups (Status Summary, Project Brief); matching, inference, and confirmation logic
is deterministic TypeScript.

## Key design decisions
- **Every action requires explicit confirmation** — the agent never silently applies a
  match or update, even at high confidence.
- **Matching excludes Shipped/Cancelled projects** (score ≥0.80 → single match,
  0.35–0.79 → candidates shown, <0.35 → new; a near-exact name match still surfaces so a
  wrongly-terminal project stays correctable).
- **Product Area → Release Size → Release Stage is one bundled question**, not three — a
  bare "no" falls back to safe defaults (Platform/Medium/GA); a partial correction
  ("not Pilot, it's Beta") is parsed and applied.
- **Date parsing handles real phrasing**: word-form numbers, filler words, month+day,
  abbreviated weekdays, bare "this week," single-letter size replies ("M"/"S"), and "a
  week later" — the last resolved against the *matched project's current* date, not
  today, since it's meaningless without a confidently identified project.
- **Release Stage is separate from Status** — a launch can be Beta and At Risk at once;
  this resolves the brief's "beta went out, is that GA or its own status?" ambiguity.
- **Two trap cases get distinct handling**: a stale-status complaint proposes fixing
  Status to Shipped; a secondhand report routes confirmation to the DRI instead of the
  (self-disclaimed) sender. Anything unclassifiable goes to `unresolved_messages`.
- **DRI, GA Date, and Requesting Team are asked for, never defaulted** — there's no safe
  placeholder for who owns a launch or when it ships, so an unanswered follow-up gets
  asked again rather than silently writing "Unassigned" / today / "Sales".
- **Customer Data Impact / Jurisdiction** are extracted only when a message signals them
  (specific accounts, GDPR, a new region), not asked on every intake — that would fatigue
  DRIs on a field that's usually not applicable.
- **Project Brief and Status Summary are maintained documents, not logs** — regenerated
  as one clean, current-state paragraph per change. Status Summary is prefixed
  `Last updated <date> by <name>`, and same-day edits replace that entry instead of
  stacking a new one per click; full history still lives in Change Log.
- **Project Stage, Scope Change, and a `Cancelled` status** go beyond the brief's minimum
  fields: Status alone conflated "is it in trouble" with "how far along is it," and
  nothing distinguished a killed project from a paused one. These, plus Portfolio Health,
  answer the brief's leadership persona ("what slipped, and when did we find out").
- **Optimistic locking on every write** — `last_updated` (bumped by a DB trigger on
  every update) doubles as a version token: the agent, and the dashboard's inline
  editor, both re-read a row immediately before writing and scope the write to
  `last_updated = <the value they just read>`. If that value has moved on (someone
  else wrote to the row in between), the write is rejected rather than silently
  applied on top of a stale snapshot — surfaced as a clear message in chat, or as a
  409 in the dashboard that pulls in the real current state (highlighting what
  changed) instead of leaving the panel showing a now-rejected draft.
- **No auth** — `Last Update By` is statically set; a real version ties this to SSO.

## What I'd do next
- Real fuzzy-matching (embeddings/trigram) over the hand-rolled Levenshtein blend
- Real notifications (email/Slack) on confirmed changes — currently just Change Log
- A UI for the `unresolved_messages` queue (DB-only today)
- Multi-select Success Metrics (Impacted Teams already is)
- Extract Collaborators/Success Metrics at intake (dashboard-only today)
- Prune Status Summary's history for very long-lived projects
- Portfolio Health's risk tiers read Status only, by design (see above) — a real version
  would let leadership tune the thresholds instead of hardcoding them
- Reminders/escalations/staleness detection (explicitly out of scope per the brief)

## What I left manual
- Resolving `unresolved_messages` — no auto-retry
- Notifying the DRI for secondhand reports — logged, not sent
- Any real auth/permissions model
- Un-committing a date (e.g. "not committing until vendor confirms") is logged to
  Dependency rather than clearing Launch Date, since `launch_date` is `NOT NULL` by design

## Running it
1. `npm install`
2. Create a Supabase project, run `supabase/schema.sql`, then any files under
   `supabase/migrations/` in order (only needed if your database predates them)
3. Copy `.env.local.example` to `.env.local`, fill in Supabase + OpenAI keys
4. `npm run dev`, or `vercel deploy` to host it
