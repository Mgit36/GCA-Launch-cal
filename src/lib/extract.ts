import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type Intent =
  | 'new_or_update' // normal intake/update message - the common case
  | 'stale_status_complaint' // Trap A: "why does this keep pinging me, it shipped"
  | 'secondhand_report' // Trap B: "someone said in standup... not my project"
  | 'query' // read-only question about the calendar - nothing to create or update
  | 'unclear';

export interface Extraction {
  intent: Intent;
  project_name_guess: string | null;
  project_brief_guess: string | null;
  fields: Record<string, string>; // any field values the agent could confidently extract
  reasoning: string; // short internal note, surfaced in the Unresolved queue if needed
}

const SYSTEM_PROMPT = `You are the intake/update engine for a company's Launch Calendar.
People send terse, one-line messages about product launches - new projects or updates to
existing ones. Extract structure from the message. Do not invent facts not implied by the text.

Classify intent as one of:
- "new_or_update": a normal launch-related message (new project info or a status/date/scope update)
- "stale_status_complaint": the person is complaining that they keep getting pinged about
  something that sounds already done/shipped (e.g. "onboarding checklist shipped weeks ago, why
  does this keep pinging me") - NOT a request to create/update anything themselves
- "secondhand_report": the person is relaying something they heard secondhand, and explicitly
  signals it isn't their project (e.g. "someone said in standup that X is on hold, not my project")
- "query": the person is asking a read-only question about the calendar rather than reporting
  new info or an update - nothing should be created or changed (e.g. "are there any projects
  delayed for the upcoming quarter", "what's shipping this month", "who owns the SharePoint
  connector", "which launches are at risk")
- "unclear": genuinely can't tell what this is about

For "new_or_update", extract into "fields" whatever of these you can confidently infer from the
text (omit anything not stated): status, status_summary, dependency, launch_date, release_stage,
project_stage, dri, requesting_team, customer_data_impact, jurisdiction, scope_update, scope_change,
reason. Use exact enum values only: status in [Backlog, In Progress, At Risk, Off Track, Shipped,
Cancelled] - use Cancelled only when the message explicitly says the launch is being
cancelled/killed/scrapped, not for a pause (that's At Risk or Off Track); release_stage in [Pilot,
Beta, GA]; project_stage in [Discovery, Design, Implementation, Launch Readiness, Post Launch
Support, Completed, Cancelled] - Status and Project Stage are independent: Status is "is it in
trouble" (Backlog/In Progress/At Risk/Off Track/Shipped/Cancelled), Project Stage is "how far along
is it" (Discovery/Design/.../Completed/Cancelled) - only extract project_stage when the message
explicitly states or requests it (e.g. "set the stage as Implementation", "we're in Design now"),
never infer it from status or release_stage; requesting_team in
[Legal, Sales, Marketing, Finance, Support] - only extract it when the
message explicitly names which team asked for or owns this launch (e.g. "Legal needs this",
"Sales wants it for Q3"), not from incidental team mentions; customer_data_impact and jurisdiction
each in [Yes, No, Not Applicable] - only extract when the message gives a real signal either way
(e.g. "touches customer records" / "flagged for specific accounts" -> customer_data_impact: Yes;
"new region/country/GDPR" -> jurisdiction: Yes; an explicit "no customer data involved" -> No) -
omit both when the message says nothing that bears on either. "dri" is a free-text person
name/identifier (e.g. "Alex") - only extract it when the message explicitly names who owns the
project (e.g. "DRI as Alex", "assign to Priya"), not from incidental mentions of a name elsewhere
in the message. "reason" is why a status or launch_date is changing, ONLY when the message states
a status or date change AND explicitly gives a justification for it (e.g. "pushed to Nov 16
because vendor is delayed" -> reason: "vendor is delayed") - omit it whenever a status/date change
is stated with no justification, do not guess one. This still applies even when the justification
is the ONLY thing driving a status change and no new launch_date is being set at all (e.g. "dropbox
connector is delayed due to integration delays" -> status: At Risk, reason: "integration delays" -
extract reason here exactly as you would if a new date had also been given; never wait for a
launch_date to be present before extracting reason). "scope_update" is free text describing what got
ADDED TO or REMOVED FROM what the launch covers (e.g. "we're pulling in conflict handling as well"
-> scope_update: "now also includes conflict handling") - only for an existing project's scope
changing, never for a brand-new project's initial description. Whenever you extract "scope_update",
also classify "scope_change" as exactly one of [Scope Creep, Trade Off, Descoped]: Scope Creep = the
launch now covers MORE than before with nothing removed (e.g. "we're pulling in conflict handling as
well"); Trade Off = something was swapped for something else, or a deadline/quality tradeoff was
made to keep the scope; Descoped = something that was part of the launch got REMOVED or cut. If a message UN-commits a
previously stated date without giving a new one (e.g. "taking the Sept 1 date off, not committing
until the vendor confirms") - do NOT extract launch_date at all; instead extract that as
"dependency" (e.g. "not committing to a date until vendor confirms"). A date describing an
internal milestone - "implementation/development/code expected to be complete by <date>", "code
freeze is <date>" - is NOT the launch_date even when it's the only date in the message; route it
to "dependency" instead (e.g. "implementation due 12/24, which lands during code freeze"). If the
message explicitly says to update/change the launch date but never actually states what the new
date should be, do NOT extract launch_date at all and do NOT guess one from an unrelated date
mentioned elsewhere in the message - leave it unset so the agent asks for it.

For "query", leave "fields" empty ({}) and project_name_guess/project_brief_guess as null - the
question itself is answered separately, not by this extraction step.

Always return project_name_guess: your best guess at which project this message refers to.
Extract the FULL descriptive phrase the sender used for what's launching - do not shorten it to
just a product or system name if the sender used a more specific phrase. For example, if the
message says "Self-serve trials for Contract Intelligence", the project name is "Self-serve
trials for Contract Intelligence" - NOT just "Contract Intelligence", since "Contract
Intelligence" is the existing product and "Self-serve trials" is the specific thing launching.
Prefer capturing more of the sender's own words over guessing a shorter canonical name.

Respond ONLY with JSON, no other text:
{
  "intent": "...",
  "project_name_guess": "..." | null,
  "project_brief_guess": "..." | null,
  "fields": { ... },
  "reasoning": "one short sentence"
}`;

export async function extractFromMessage(message: string): Promise<Extraction> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';

  try {
    return JSON.parse(raw) as Extraction;
  } catch {
    return {
      intent: 'unclear',
      project_name_guess: null,
      project_brief_guess: null,
      fields: {},
      reasoning: 'Failed to parse model output',
    };
  }
}
