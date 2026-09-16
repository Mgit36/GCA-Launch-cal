import OpenAI from 'openai';
import type { Launch } from './types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You write the Status Summary field for a company's Launch Calendar entry.

Given the launch's current full state as JSON (status, launch_date, dependency, etc.) and
optionally the most recent update reported about it, write ONE short, polished sentence (two only
if truly necessary) stating where the launch stands right now - status, target date if relevant,
and any key blocker from Dependency if one exists.

This is a snapshot of the CURRENT state for an executive audience, not a log of changes: never
mention who updated what or when, never reference past values or previous dates, never say
"updated" or "changed". Do not repeat the project name. No JSON, no bullet points - plain text only.`;

export async function generateStatusSummary(
  launch: Partial<Launch> & { project: string },
  recentUpdateNote?: string
): Promise<string> {
  // The launch's own current status_summary is about to be replaced by this call's
  // output - it must never be fed back in as input, or the model anchors on its own
  // prior wording instead of regenerating fresh from status/launch_date/dependency.
  const { status_summary: _omit, ...factsOnly } = launch;
  const userContent = recentUpdateNote
    ? `Current state:\n${JSON.stringify(factsOnly)}\n\nMost recent update reported: ${recentUpdateNote}`
    : `Current state:\n${JSON.stringify(factsOnly)}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 150,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? '';
}

const BRIEF_SYSTEM_PROMPT = `You write the Project Brief field for a company's Launch Calendar entry.

Given the launch's current Project Brief and a note about how its scope just changed, rewrite the
Project Brief as ONE polished sentence (two only if truly necessary) that describes what the launch
covers RIGHT NOW, incorporating the new scope into the description.

This is an executive-readable description of what's shipping, not a scratch note or a change log:
never say "added", "now also includes", "updated", or reference the fact that scope changed - just
describe the resulting scope as if writing it fresh. Do not mention who changed it or when. No
JSON, no bullet points - plain text only.`;

/**
 * Rewrites Project Brief to reflect a scope change, in the same spirit as
 * generateStatusSummary: a clean current-state description for an executive
 * reader, not raw notes appended over time (Dependency/Change Log already
 * cover the append-only history).
 */
export async function generateProjectBrief(currentBrief: string, scopeUpdateNote: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 150,
    messages: [
      { role: 'system', content: BRIEF_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Current Project Brief: ${currentBrief}\n\nScope change: ${scopeUpdateNote}`,
      },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? currentBrief;
}
