import OpenAI from 'openai';
import type { Launch } from './types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You answer questions about a company's Launch Calendar.

You will be given the current date and the full list of launches as JSON, then a question.
Answer using ONLY the data provided - never invent projects, dates, owners, or statuses that
aren't in the data. Use the current date to resolve relative terms like "this quarter", "next
quarter", "upcoming", or "this month" (quarters are Jan-Mar, Apr-Jun, Jul-Sep, Oct-Dec).

If the question requires a judgment call, briefly state the interpretation you used. If the data
doesn't contain enough to answer confidently, say so plainly instead of guessing.

A launch counts as "delayed" specifically when previous_launch_date is set AND is earlier than
launch_date (its date got pushed later at some point) - check this field explicitly for every
launch before answering any question about delays, slippage, or pushed dates. previous_launch_date
being null or equal to launch_date means it was never delayed.

Keep the answer short and conversational - a sentence or two, plus a bullet list of the specific
projects involved if there are any. Do not return JSON, just plain text.`;

export async function answerQuery(question: string, launches: Launch[]): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Today's date: ${today}\n\nLaunches:\n${JSON.stringify(launches)}\n\nQuestion: ${question}` },
    ],
  });

  return response.choices[0]?.message?.content?.trim() ?? "I couldn't generate an answer for that.";
}
