import OpenAI from 'openai';
import type { Launch } from './types';
import { quarterOf } from './quarter';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You answer questions about a company's Launch Calendar.

You will be given the current date, the exact labels for "this quarter" and "next/upcoming
quarter", and the full list of launches as JSON, then a question. Answer using ONLY the data
provided - never invent projects, dates, owners, or statuses that aren't in the data. Fiscal year
matches calendar year (starts January), so quarters are Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep, Q4
Oct-Dec.

Each launch includes a precomputed "quarter" field (e.g. "Q4 2026"), and the user message states
the exact label for "this quarter" and "next quarter"/"upcoming". HARD RULE: for any question
about this quarter, next quarter, "upcoming", or a specific quarter (e.g. "Q1 2027"), filter
launches by exact string match against the "quarter" field and the quarter label(s) given - do not
compute quarter boundaries or reason about dates yourself, and do not include a launch whose
quarter doesn't match just because it's nearby or also at risk.

When a question combines multiple conditions (e.g. delayed AND in a specific quarter), check EVERY
launch in the list against ALL of the conditions individually before answering - do not stop after
finding one or two matches. Undercounting is just as wrong as inventing a match.

If the question requires a judgment call, briefly state the interpretation you used. If the data
doesn't contain enough to answer confidently, say so plainly instead of guessing.

Each launch includes a precomputed "delayed" boolean field - true means previous_launch_date is
set and earlier than launch_date (its date got pushed later at some point). This is the ONLY
signal for delay/slippage/pushed-date questions. HARD RULE: when asked about delayed, slipped, or
pushed-back launches, the answer set is EXACTLY the launches with delayed: true - nothing more,
nothing less. Do not add launches whose status is merely At Risk or Off Track but whose delayed
field is false; being at risk of missing a date and having already had a date pushed are different
facts, and a status-based judgment call is not a substitute for checking this field. If zero
launches have delayed: true, say plainly that none have been delayed, even if some are At Risk or
Off Track for unrelated reasons.

Keep the answer short and conversational - a sentence or two, plus a bullet list of the specific
projects involved if there are any. Do not return JSON, just plain text.`;

export async function answerQuery(question: string, launches: Launch[]): Promise<string> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // Whether a launch is "delayed" is a precise, deterministic comparison - computing
  // it here and handing the model a plain boolean avoids relying on gpt-4o-mini to
  // apply that comparison correctly (and consistently) itself on every call.
  const annotated = launches.map((l) => ({
    ...l,
    delayed: !!l.previous_launch_date && l.previous_launch_date < l.launch_date,
    quarter: quarterOf(l.launch_date),
  }));
  // Same reasoning as "delayed": which quarter is "this quarter" vs "next quarter" is
  // a precise calendar computation (fiscal year = calendar year, Jan start), not
  // something to leave to the model's own date arithmetic run to run. Computed
  // directly from `now`'s own local month/year - deliberately not routed through a
  // toISOString() + re-parse round trip, which reintroduces the same UTC-vs-local
  // timezone bug quarterOf() itself was just fixed to avoid.
  const thisQuarterIndex = Math.floor(now.getMonth() / 3);
  const thisQuarterLabel = `Q${thisQuarterIndex + 1} ${now.getFullYear()}`;
  const nextQuarterIndex = (thisQuarterIndex + 1) % 4;
  const nextQuarterYear = now.getFullYear() + (thisQuarterIndex === 3 ? 1 : 0);
  const nextQuarterLabel = `Q${nextQuarterIndex + 1} ${nextQuarterYear}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Today's date: ${today}\nThis quarter: ${thisQuarterLabel}\nNext/upcoming quarter: ${nextQuarterLabel}\n\nLaunches:\n${JSON.stringify(annotated)}\n\nQuestion: ${question}`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "I couldn't generate an answer for that.";
}
