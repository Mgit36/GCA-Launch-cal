# Launch Calendar Agent — README

## What this is
Next.js app with a conversational intake/update agent for the Launch Calendar, plus a
dashboard (Launches table + Portfolio Health). Supabase (Postgres) for storage;
`gpt-4o-mini` for extraction and the two executive write-ups (Status Summary, Project
Brief); matching, inference, and confirmation logic is deterministic TypeScript.

## Key design decisions
- **Every action requires explicit confirmation** — never applied silently, even at high confidence.
- **Matching**: excludes Shipped/Cancelled (≥0.80 → single match, 0.35–0.79 → candidates,
  <0.35 → new), with a near-exact name still surfacing so a wrongly-terminal project
  stays correctable.
- **Product Area → Release Size → Release Stage** is one bundled question — bare "no"
  defaults to Platform/Medium/GA, partial corrections ("not Pilot, it's Beta") are parsed.
- **Date parsing** handles real phrasing (word numbers, weekdays, quarters, early/mid/late
  month/quarter/year); "a week later" resolves against the *matched project's current*
  date, not today.
- **Release Stage is separate from Status** — a launch can be Beta and At Risk at once.
- **Trap cases**: a stale-status complaint proposes Status → Shipped (declining flags the
  DRI instead of dropping it); a secondhand report routes confirmation to the DRI, not the
  sender. Unclassifiable messages go to `unresolved_messages`.
- **DRI, GA Date, Requesting Team, Business Priority, Success Metrics** are asked for on
  creation, never defaulted.
- **Customer Data Impact / Jurisdiction** are Yes/No only, extracted only when a message
  signals them, default No.
- **New projects >1 month out default Status to Backlog**, not In Progress. **Scope
  Change is never set on creation** — only meaningful relative to a prior scope.
- **Project Brief / Status Summary are maintained documents, not logs** — regenerated
  fresh each change, dated/attributed, same-day edits collapse into one entry.
- **Project Stage, Scope Change, and a `Cancelled` status** separate "is it in trouble"
  from "how far along," feeding Portfolio Health.
- **Optimistic locking on every write** — scoped to the `last_updated` value just read; a
  stale write is rejected (a chat message, or a 409 in the dashboard) instead of silently
  clobbering.
- **No auth** — `Last Update By` is static; a real version ties this to SSO.

## Known limitations / what's next
- Real fuzzy-matching (embeddings/trigram) over the hand-rolled Levenshtein blend
- Real notifications (email/Slack) on confirmed changes — currently just Change Log
- A UI for the `unresolved_messages` queue (DB-only today)
- Multi-select Success Metrics (Impacted Teams already is)
- Extract Collaborators at intake (dashboard-only today; Success Metrics is now
  extracted at intake and required at creation, same as DRI/date/team)
- Prune Status Summary's history for very long-lived projects
- Portfolio Health's risk tiers read Status only, by design — a real version would let
  leadership tune the thresholds instead of hardcoding them
- Reminders/escalations/staleness detection (explicitly out of scope per the brief)
- Any real auth/permissions model (see "No auth" above)

## Running it
1. `npm install`
2. Create a Supabase project, run `supabase/schema.sql`, then `supabase/migrations/*` in order
3. Copy `.env.local.example` → `.env.local`, fill in Supabase + OpenAI keys
4. `npm run dev`, or `vercel deploy` to host it
