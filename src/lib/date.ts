// Normalizes free-text launch_date values extracted from user messages into
// the YYYY-MM-DD strings the `launches.launch_date` (date, not null) column requires.
// Business days are Monday-Friday. Any date this module *infers* from a relative
// phrase is forced onto a business day; an explicit YYYY-MM-DD, or an explicit
// "Month Day" the user typed, is passed through as-is (they said exactly what
// they meant, weekend or not).

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isValidIsoDate(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const [, ys, ms, ds] = match;
  const y = Number(ys);
  const mo = Number(ms);
  const d = Number(ds);
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function isBusinessDay(d: Date): boolean {
  const day = d.getDay(); // Sunday = 0 ... Saturday = 6
  return day !== 0 && day !== 6;
}

function adjustToBusinessDay(d: Date, direction: 'forward' | 'backward'): Date {
  const result = new Date(d);
  while (!isBusinessDay(result)) {
    result.setDate(result.getDate() + (direction === 'forward' ? 1 : -1));
  }
  return result;
}

function lastDayOfMonth(year: number, monthIndex: number): Date {
  return new Date(year, monthIndex + 1, 0);
}

// Word-form amounts ("a", "two", "three"...) show up constantly in real replies
// ("in about two weeks", "a week later") - digit-only parsing missed all of them.
const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const AMOUNT_ALT = `\\d+|${Object.keys(WORD_NUMBERS).join('|')}`;

function parseAmount(token: string): number {
  const lower = token.toLowerCase();
  return WORD_NUMBERS[lower] ?? Number(token);
}

// Weekday full names + the abbreviations people actually type ("tues", "thu").
// Keyed so a match resolves straight to a day-of-week index.
const WEEKDAY_ALIASES: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

// Nearest occurrence of `targetDow` strictly after `from` (never returns `from`
// itself) - matches the convention most date libraries use (e.g. date-fns
// `nextFriday`), where "this Friday" and "next Friday" resolve to the same date.
function nextOccurrenceOf(targetDow: number, from: Date): Date {
  const result = startOfDay(from);
  let diff = (targetDow - result.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  result.setDate(result.getDate() + diff);
  return result;
}

// Unanchored (matched anywhere, not requiring the whole string) so these also work when
// called on a full free-text correction sentence (e.g. "actually push it to next Friday
// instead"), not just on the clean phrase the extraction step normally passes in.
const END_OF_MONTH = /(?:end of (?:this |the )?month)|\beom\b/i;
const END_OF_NEXT_MONTH = /end of next month/i;
const WEEKDAY_PATTERN = new RegExp(
  `\\b(?:next |this |coming )?(${Object.keys(WEEKDAY_ALIASES).join('|')})\\b`,
  'i'
);
const TOMORROW = /\btomorrow\b/i;
const THIS_WEEK = /\bthis week\b/i;
const NEXT_WEEK = /\bnext week\b/i;
const NEXT_MONTH = /\bnext month\b/i;
// Optional filler ("in ABOUT two weeks", "in roughly 10 days") sits between "in" and
// the amount in how people actually write these - the original digit-only, no-filler
// regexes missed exactly this phrasing.
const FILLER = '(?:about |roughly |approximately )?';
const IN_N_DAYS = new RegExp(`\\bin ${FILLER}(${AMOUNT_ALT}) days?\\b`, 'i');
const IN_N_WEEKS = new RegExp(`\\bin ${FILLER}(${AMOUNT_ALT}) weeks?\\b`, 'i');
const IN_N_MONTHS = new RegExp(`\\bin ${FILLER}(${AMOUNT_ALT}) months?\\b`, 'i');
const EMBEDDED_ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/;

const MONTH_ALIASES: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};
// "early/mid/late <month>" - a bare month name alone ("in November") is deliberately
// NOT handled: it's genuinely ambiguous (which day?) where early/mid/late at least
// pins down roughly which third of the month is meant.
const EARLY_MID_LATE_MONTH = new RegExp(
  `\\b(early|mid|late)\\s+(${Object.keys(MONTH_ALIASES).join('|')})\\b`,
  'i'
);
// An explicit day-level date ("Sep 7", "September 7th") - unlike early/mid/late,
// this pins an exact day, so like an ISO date it's taken literally (no business-day
// forcing) rather than treated as an inference.
const MONTH_DAY = new RegExp(
  `\\b(${Object.keys(MONTH_ALIASES).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  'i'
);

/**
 * Resolves a raw launch_date value from message extraction into a YYYY-MM-DD
 * string, or null if it can't be confidently resolved (callers should route
 * null to the unresolved-messages queue rather than guessing).
 */
export function normalizeLaunchDate(raw: string, now: Date = new Date()): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (isValidIsoDate(trimmed)) return trimmed;

  const embeddedIso = EMBEDDED_ISO_DATE.exec(trimmed);
  if (embeddedIso && isValidIsoDate(embeddedIso[0])) return embeddedIso[0];

  const lower = trimmed.toLowerCase();

  if (END_OF_MONTH.test(lower)) {
    return toDateString(adjustToBusinessDay(lastDayOfMonth(now.getFullYear(), now.getMonth()), 'backward'));
  }

  if (END_OF_NEXT_MONTH.test(lower)) {
    return toDateString(adjustToBusinessDay(lastDayOfMonth(now.getFullYear(), now.getMonth() + 1), 'backward'));
  }

  const earlyMidLateMatch = EARLY_MID_LATE_MONTH.exec(lower);
  if (earlyMidLateMatch) {
    const qualifier = earlyMidLateMatch[1].toLowerCase();
    const monthIndex = MONTH_ALIASES[earlyMidLateMatch[2].toLowerCase()];
    const day = qualifier === 'early' ? 5 : qualifier === 'late' ? 25 : 15;
    let year = now.getFullYear();
    let candidate = new Date(year, monthIndex, day);
    if (candidate < startOfDay(now)) {
      year += 1;
      candidate = new Date(year, monthIndex, day);
    }
    return toDateString(adjustToBusinessDay(candidate, 'forward'));
  }

  const monthDayMatch = MONTH_DAY.exec(lower);
  if (monthDayMatch) {
    const monthIndex = MONTH_ALIASES[monthDayMatch[1].toLowerCase()];
    const day = Number(monthDayMatch[2]);
    let year = now.getFullYear();
    let candidate = new Date(year, monthIndex, day);
    if (candidate < startOfDay(now)) {
      year += 1;
      candidate = new Date(year, monthIndex, day);
    }
    return toDateString(candidate);
  }

  const weekdayMatch = WEEKDAY_PATTERN.exec(lower);
  if (weekdayMatch) {
    const targetDow = WEEKDAY_ALIASES[weekdayMatch[1].toLowerCase()];
    return toDateString(adjustToBusinessDay(nextOccurrenceOf(targetDow, now), 'forward'));
  }

  if (TOMORROW.test(lower)) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + 1);
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  // "this week" (unqualified, no specific day given) resolves to the Friday of the
  // current week - the same "pin down a specific day" role early/mid/late plays for a
  // bare month. Checked after TOMORROW/before NEXT_WEEK's own check is irrelevant here
  // since "this week" never contains the substring "next week".
  if (THIS_WEEK.test(lower)) {
    const day = now.getDay(); // 0 = Sunday ... 6 = Saturday
    const d = startOfDay(now);
    d.setDate(d.getDate() + Math.max(5 - day, 0)); // Friday of the current week, or today if already past it
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  if (NEXT_WEEK.test(lower)) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + 7);
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  if (NEXT_MONTH.test(lower)) {
    const d = startOfDay(now);
    d.setMonth(d.getMonth() + 1);
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  const nDays = IN_N_DAYS.exec(lower);
  if (nDays) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + parseAmount(nDays[1]));
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  const nWeeks = IN_N_WEEKS.exec(lower);
  if (nWeeks) {
    const d = startOfDay(now);
    d.setDate(d.getDate() + parseAmount(nWeeks[1]) * 7);
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  const nMonths = IN_N_MONTHS.exec(lower);
  if (nMonths) {
    const d = startOfDay(now);
    d.setMonth(d.getMonth() + parseAmount(nMonths[1]));
    return toDateString(adjustToBusinessDay(d, 'forward'));
  }

  return null;
}

export type RelativeShift = { amount: number; unit: 'day' | 'week' | 'month' };

// "a week later", "slipping by two weeks", "pushed back a month" - phrased relative
// to whatever date is *currently on the record*, not relative to today. These must
// be resolved against the matched project's existing launch_date (see
// applyRelativeShift), which normalizeLaunchDate has no access to.
const LATER_PATTERN = new RegExp(`\\b(${AMOUNT_ALT})\\s+(day|week|month)s?\\s+later\\b`, 'i');
const SLIPPING_PATTERN = new RegExp(
  `\\bslip(?:ping|s|ped)?(?: by)?\\s+(${AMOUNT_ALT})\\s+(day|week|month)s?\\b`,
  'i'
);
const PUSHED_BACK_PATTERN = new RegExp(
  `\\bpush(?:ed|ing)? back(?: by)?\\s+(${AMOUNT_ALT})\\s+(day|week|month)s?\\b`,
  'i'
);

export function parseRelativeShift(raw: string): RelativeShift | null {
  const lower = raw.trim().toLowerCase();
  for (const pattern of [LATER_PATTERN, SLIPPING_PATTERN, PUSHED_BACK_PATTERN]) {
    const match = pattern.exec(lower);
    if (match) {
      return { amount: parseAmount(match[1]), unit: match[2].toLowerCase() as RelativeShift['unit'] };
    }
  }
  return null;
}

/**
 * Applies a relative shift ("a week later") on top of `baseDateStr` (the
 * project's *current* launch_date, supplied by the caller once a project is
 * matched) rather than on top of today. Like other inferred (non-literal)
 * dates, the result is forced onto a business day. Returns null if `raw`
 * isn't a relative-shift phrase.
 */
export function applyRelativeShift(baseDateStr: string, raw: string): string | null {
  const shift = parseRelativeShift(raw);
  if (!shift) return null;
  const [y, m, d] = baseDateStr.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  if (shift.unit === 'day') base.setDate(base.getDate() + shift.amount);
  else if (shift.unit === 'week') base.setDate(base.getDate() + shift.amount * 7);
  else base.setMonth(base.getMonth() + shift.amount);
  return toDateString(adjustToBusinessDay(base, 'forward'));
}
