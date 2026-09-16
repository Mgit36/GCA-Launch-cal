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

Today's date is {{TODAY}}. You will need this to sanity-check any date you reason about, but see
the launch_date instructions below - you should almost never need to resolve a date yourself.

For EVERY message, regardless of intent, also extract project_name_guess: your best guess at
which project is being discussed, copying the sender's own words for it. This applies just as
much to "stale_status_complaint" and "secondhand_report" messages as to "new_or_update" ones -
a complaint or secondhand report is still about a specific, nameable project, and leaving
project_name_guess null when the message plainly names one (e.g. "onboarding checklist shipped
weeks ago..." names "onboarding checklist") makes it impossible to look up which project the
message is about. Only leave it null when the message truly gives no nameable project at all.

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
project_stage, dri, requesting_team, customer_data_impact, jurisdiction, business_priority,
success_metrics, scope_update, scope_change, reason. Use exact enum values only: status in [Backlog, In Progress, At Risk, Off Track, Shipped,
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
each in [Yes, No] - only extract when the message gives a real signal either way (e.g. "touches
customer records" / "flagged for specific accounts" -> customer_data_impact: Yes; "new
region/country/GDPR" -> jurisdiction: Yes; an explicit "no customer data involved" -> No) - omit
both when the message says nothing that bears on either (do not guess No just because nothing was
said - omitting and stating No are different things). business_priority in [Critical, High, Medium,
Low] - only extract when the message explicitly signals priority/urgency in those terms (e.g. "this
is critical", "high priority", "low priority, nice to have") - do not infer it from Status or
tone/urgency-sounding language alone (an "At Risk" status is not itself a priority signal).
success_metrics in [Regulatory & Compliance, Productivity, Growth, Activation, Retention] - only
extract when the message states or clearly implies which business outcome the launch is meant to
drive (e.g. "this is to meet GDPR requirements" -> Regulatory & Compliance; "to cut manual review
time" -> Productivity; "to grow signups" -> Growth or Activation; "to reduce churn" -> Retention) -
never guess one just because a launch exists; omit it when the message gives no real signal either
way. "dri" is a free-text person
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
ADDED TO or REMOVED FROM what the launch covers relative to something already on record (e.g. "we're
pulling in conflict handling as well" -> scope_update: "now also includes conflict handling") -
ONLY for an existing project's scope changing. NEVER extract scope_update or scope_change for a
brand-new project being described for the first time, even if the message has multiple sentences or
clauses elaborating on what it covers ("Launching X. This also covers Y." is just X's initial
description, in full - Y is not a change from anything, since there is no prior scope yet to change
from). If you cannot tell whether a message is describing an existing project's change or a new
project's initial scope, do not extract scope_update/scope_change at all. Whenever you extract "scope_update",
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

CRITICAL for launch_date: extract it EXACTLY as the sender phrased it ("Nov 20", "next Friday",
"3rd week of January", "in about two weeks", "12/24") - do NOT convert it to YYYY-MM-DD or any
other resolved date format yourself. A separate deterministic step resolves the phrase against
today's actual date ({{TODAY}}); you do not reliably know what year an unqualified month/day like
"Nov 20" refers to, and guessing wrong silently writes the wrong year into the calendar. The only
exception is when the sender already wrote a fully-specified date themselves (e.g. "2026-11-20" or
"11/20/2026") - pass that through unchanged, do not reformat it either.

For "query", leave "fields" empty ({}) and project_name_guess/project_brief_guess as null - the
question itself is answered separately, not by this extraction step.

For project_name_guess (see also the instruction above requiring it for every intent), extract the
FULL descriptive phrase the sender used for what's launching - do not shorten it to just a product
or system name if the sender used a more specific phrase. For example, if the message says
"Self-serve trials for Contract Intelligence", the project name is "Self-serve trials for Contract
Intelligence" - NOT just "Contract Intelligence", since "Contract Intelligence" is the existing
product and "Self-serve trials" is the specific thing launching. Prefer capturing more of the
sender's own words over guessing a shorter canonical name.

Respond ONLY with JSON, no other text:
{
  "intent": "...",
  "project_name_guess": "..." | null,
  "project_brief_guess": "..." | null,
  "fields": { ... },
  "reasoning": "one short sentence"
}`;

// Intents where a null project_name_guess is essentially always a loss - there's
// nothing else callers can key a project lookup off of, so it's worth one retry
// rather than accepting a coin-flip failure (see callExtraction's retry below).
const NEEDS_PROJECT_NAME = new Set<Intent>(['new_or_update', 'stale_status_complaint', 'secondhand_report']);

async function callExtraction(message: string, today: string): Promise<Extraction> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    // Pinned to 0: this is a structured-extraction step, not a creative one, and
    // classification/field extraction should be as repeatable as possible for the
    // same input rather than drifting run to run.
    temperature: 0,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT.replace(/\{\{TODAY\}\}/g, today) },
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

export async function extractFromMessage(message: string): Promise<Extraction> {
  const today = new Date().toISOString().slice(0, 10);
  const first = await callExtraction(message, today);
  if (first.project_name_guess || !NEEDS_PROJECT_NAME.has(first.intent)) return first;
  // The message plainly needs a project to act on but the model didn't produce one
  // (e.g. a stale-status complaint that names its project in plain text) - one retry
  // is cheap insurance against an isolated miss, rather than silently routing a
  // resolvable message to the unresolved queue.
  const retry = await callExtraction(message, today);
  return retry.project_name_guess ? retry : first;
}

export interface RequiredFieldAnswers {
  dri?: string;
  requesting_team?: string;
  launch_date?: string;
  business_priority?: string;
  success_metrics?: string;
}

const REQUIRED_FIELD_ANSWER_PROMPT = `A user is being asked to answer specific missing fields for a
Launch Calendar entry that's already in the middle of being created - they are NOT sending a
standalone message, so do not classify intent, guess a project name, or require the reply to look
like a complete sentence or contain enough context to stand on its own. Their reply is answering one
or more of: who the DRI is, what the target launch date is, which team requested this, how urgent it
is, or what business outcome it's meant to drive. A terse fragment like "Casey Wong and Legal" or
"High priority, Growth" is a completely normal, sufficient answer - extract whatever it states even
with no other context.

Extract into JSON:
- "dri": free-text person name/identifier, only if a name is stated (e.g. "Casey Wong", "assign to
  Casey" -> "Casey"). Omit if no name is present.
- "requesting_team": exactly one of [Legal, Sales, Marketing, Finance, Support], only if one of
  these is named. Omit otherwise.
- "launch_date": the date exactly as phrased ("Nov 20", "mid next year") - do NOT resolve or
  reformat it. Omit if no date is stated.
- "business_priority": exactly one of [Critical, High, Medium, Low], only if one of these (or an
  unambiguous synonym like "urgent" -> Critical) is stated. Omit otherwise.
- "success_metrics": exactly one of [Regulatory & Compliance, Productivity, Growth, Activation,
  Retention], only if one of these (or a clear paraphrase of one) is stated. Omit otherwise.
A key that isn't stated in the reply must be left OUT of the JSON object entirely - never include
it with a placeholder value like the word "omitted", "null", "N/A", or an empty string; those are
not valid values for any of these fields and must never appear. Respond ONLY with a JSON object
containing exactly the keys that were actually stated, nothing else - e.g. if only DRI and requesting
team were stated, respond with just {"dri": "...", "requesting_team": "..."}.`;

/**
 * Narrow, context-free extractor for a reply to the "who's the DRI / what's the
 * date / which team / priority / success metric" follow-up asked when creating a
 * new project. Deliberately does NOT reuse extractFromMessage: that function first
 * classifies intent (new_or_update/query/unclear/...), and a bare fragment
 * answering a specific question - "DRI is Casey Wong and Legal", with no project
 * context at all - can confidently come back "unclear" from that classification
 * step, silently discarding fields the user did state. This function skips
 * classification entirely, since the agent already knows exactly what's being asked.
 */
export async function extractRequiredFieldAnswers(replyText: string): Promise<RequiredFieldAnswers> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: REQUIRED_FIELD_ANSWER_PROMPT },
      { role: 'user', content: replyText },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '{}';
  try {
    return JSON.parse(raw) as RequiredFieldAnswers;
  } catch {
    return {};
  }
}
