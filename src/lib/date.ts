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
const END_OF_YEAR = /(?:end of (?:this |the )?year)|\beoy\b|\bby year[- ]end\b/i;
// Quarters/halves are how launch dates actually get talked about in this domain
// ("targeting Q4", "shipping in H2") - resolved to the last business day of the
// period, the same "pick one concrete day out of a coarser period" convention
// end-of-month already uses.
const QUARTER_END_MONTH = [2, 5, 8, 11]; // last month index of Q1..Q4 (Mar, Jun, Sep, Dec)
const QUARTER_PATTERN = /\bq([1-4])(?:\s+(?:of\s+)?(\d{4}))?\b/i;
const THIS_QUARTER = /\bthis quarter\b/i;
const NEXT_QUARTER = /\bnext quarter\b/i;
// "early/mid/late Q4" - same role as EARLY_MID_LATE_MONTH, but for a quarter: picks
// the first/middle/last month of that quarter, then the same day-of-month (5/15/25)
// early/mid/late already means for a plain month. Must be checked before the bare
// QUARTER_PATTERN below, or "early Q4" would match as bare "Q4" first and lose the
// qualifier.
const EARLY_MID_LATE_QUARTER = /\b(early|mid|late)\s+q([1-4])(?:\s+(?:of\s+)?(\d{4}))?\b/i;
// "mid next year", "early this year", "late next year" - the same early/mid/late
// convention scaled up a level: splits the year into three ~4-month bands (Jan-Apr /
// May-Aug / Sep-Dec) and picks a representative mid-band month (Feb/Jul/Nov, day 15)
// rather than a day-of-month or day-of-quarter, since "year" granularity is coarser
// than either. "this"/"next" pins the year explicitly, so unlike EARLY_MID_LATE_MONTH
// there's no "did this already pass" rollover to compute.
const EARLY_MID_LATE_YEAR = /\b(early|mid|late)\s+(this|next)\s+year\b/i;
const HALF_END_MONTH = [5, 11]; // last month index of H1, H2 (Jun, Dec)
const HALF_YEAR_PATTERN = /\bh([12])(?:\s+(?:of\s+)?(\d{4}))?\b/i;
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
// "3rd week of January", "first week of Feb" - people often talk about launch timing
// in terms of a calendar week rather than a specific day. Like EARLY_MID_LATE_MONTH,
// this is an inferred approximation, not a literal date: each ordinal maps to a
// representative day 7 apart (5, 12, 19, 26, ...) - day 5 for "1st week" mirrors the
// "day 5 = early" convention EARLY_MID_LATE_MONTH already uses, and it's forced onto
// a business day like any other inference.
const WEEK_OF_MONTH_ORDINALS: Record<string, number> = {
  '1st': 1, first: 1,
  '2nd': 2, second: 2,
  '3rd': 3, third: 3,
  '4th': 4, fourth: 4,
  '5th': 5, fifth: 5,
};
const WEEK_OF_MONTH = new RegExp(
  `\\b(${Object.keys(WEEK_OF_MONTH_ORDINALS).join('|')})\\s+week\\s+of\\s+(${Object.keys(MONTH_ALIASES).join('|')})\\b`,
  'i'
);
const MONTH_DAY = new RegExp(
  `\\b(${Object.keys(MONTH_ALIASES).join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`,
  'i'
);
// "end of December" - like END_OF_MONTH/END_OF_NEXT_MONTH but for a month named
// explicitly rather than "this"/"next" month.
const END_OF_SPECIFIC_MONTH = new RegExp(
  `\\bend of (?:this |the )?(${Object.keys(MONTH_ALIASES).join('|')})\\b`,
  'i'
);
// "12/24", "3/15/2026" - numeric month/day, interpreted as M/D (the same order
// MONTH_DAY's word-form already uses). Like MONTH_DAY, an explicit day is taken
// literally (no business-day forcing). The 3-part form states its year explicitly
// and is used as-is; the 2-part form's year is inferred the same way MONTH_DAY
// infers one: this year if the month/day hasn't passed yet, otherwise next year.
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

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

  if (END_OF_YEAR.test(lower)) {
    return toDateString(adjustToBusinessDay(lastDayOfMonth(now.getFullYear(), 11), 'backward'));
  }

  const endOfSpecificMonthMatch = END_OF_SPECIFIC_MONTH.exec(lower);
  if (endOfSpecificMonthMatch) {
    const monthIndex = MONTH_ALIASES[endOfSpecificMonthMatch[1].toLowerCase()];
    let year = now.getFullYear();
    let candidate = lastDayOfMonth(year, monthIndex);
    if (candidate < startOfDay(now)) {
      year += 1;
      candidate = lastDayOfMonth(year, monthIndex);
    }
    return toDateString(adjustToBusinessDay(candidate, 'backward'));
  }

  if (THIS_QUARTER.test(lower)) {
    const q = Math.floor(now.getMonth() / 3);
    return toDateString(adjustToBusinessDay(lastDayOfMonth(now.getFullYear(), QUARTER_END_MONTH[q]), 'backward'));
  }

  if (NEXT_QUARTER.test(lower)) {
    const q = Math.floor(now.getMonth() / 3) + 1;
    const year = now.getFullYear() + (q > 3 ? 1 : 0);
    return toDateString(adjustToBusinessDay(lastDayOfMonth(year, QUARTER_END_MONTH[q % 4]), 'backward'));
  }

  const earlyMidLateQuarterMatch = EARLY_MID_LATE_QUARTER.exec(lower);
  if (earlyMidLateQuarterMatch) {
    const qualifier = earlyMidLateQuarterMatch[1].toLowerCase();
    const qIndex = Number(earlyMidLateQuarterMatch[2]) - 1;
    const monthOffset = qualifier === 'early' ? 0 : qualifier === 'late' ? 2 : 1;
    const monthIndex = qIndex * 3 + monthOffset;
    const day = qualifier === 'early' ? 5 : qualifier === 'late' ? 25 : 15;
    let year = earlyMidLateQuarterMatch[3] ? Number(earlyMidLateQuarterMatch[3]) : now.getFullYear();
    let candidate = new Date(year, monthIndex, day);
    if (!earlyMidLateQuarterMatch[3] && candidate < startOfDay(now)) {
      year += 1;
      candidate = new Date(year, monthIndex, day);
    }
    return toDateString(adjustToBusinessDay(candidate, 'forward'));
  }

  const earlyMidLateYearMatch = EARLY_MID_LATE_YEAR.exec(lower);
  if (earlyMidLateYearMatch) {
    const qualifier = earlyMidLateYearMatch[1].toLowerCase();
    const which = earlyMidLateYearMatch[2].toLowerCase();
    const year = now.getFullYear() + (which === 'next' ? 1 : 0);
    const monthIndex = qualifier === 'early' ? 1 : qualifier === 'late' ? 10 : 6; // Feb / Jul / Nov
    const candidate = new Date(year, monthIndex, 15);
    return toDateString(adjustToBusinessDay(candidate, 'forward'));
  }

  const quarterMatch = QUARTER_PATTERN.exec(lower);
  if (quarterMatch) {
    const qIndex = Number(quarterMatch[1]) - 1;
    let year = quarterMatch[2] ? Number(quarterMatch[2]) : now.getFullYear();
    let candidate = lastDayOfMonth(year, QUARTER_END_MONTH[qIndex]);
    if (!quarterMatch[2] && candidate < startOfDay(now)) {
      year += 1;
      candidate = lastDayOfMonth(year, QUARTER_END_MONTH[qIndex]);
    }
    return toDateString(adjustToBusinessDay(candidate, 'backward'));
  }

  const halfMatch = HALF_YEAR_PATTERN.exec(lower);
  if (halfMatch) {
    const hIndex = Number(halfMatch[1]) - 1;
    let year = halfMatch[2] ? Number(halfMatch[2]) : now.getFullYear();
    let candidate = lastDayOfMonth(year, HALF_END_MONTH[hIndex]);
    if (!halfMatch[2] && candidate < startOfDay(now)) {
      year += 1;
      candidate = lastDayOfMonth(year, HALF_END_MONTH[hIndex]);
    }
    return toDateString(adjustToBusinessDay(candidate, 'backward'));
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

  const weekOfMonthMatch = WEEK_OF_MONTH.exec(lower);
  if (weekOfMonthMatch) {
    const weekNum = WEEK_OF_MONTH_ORDINALS[weekOfMonthMatch[1].toLowerCase()];
    const monthIndex = MONTH_ALIASES[weekOfMonthMatch[2].toLowerCase()];
    let year = now.getFullYear();
    const dayFor = (y: number) => Math.min(5 + (weekNum - 1) * 7, lastDayOfMonth(y, monthIndex).getDate());
    let candidate = new Date(year, monthIndex, dayFor(year));
    if (candidate < startOfDay(now)) {
      year += 1;
      candidate = new Date(year, monthIndex, dayFor(year));
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

  const slashMatch = SLASH_DATE.exec(trimmed);
  if (slashMatch) {
    const monthNum = Number(slashMatch[1]);
    const dayNum = Number(slashMatch[2]);
    if (monthNum >= 1 && monthNum <= 12 && dayNum >= 1 && dayNum <= 31) {
      const monthIndex = monthNum - 1;
      if (slashMatch[3]) {
        let year = Number(slashMatch[3]);
        if (year < 100) year += 2000;
        const candidate = new Date(year, monthIndex, dayNum);
        if (candidate.getMonth() === monthIndex) return toDateString(candidate);
      } else {
        let year = now.getFullYear();
        let candidate = new Date(year, monthIndex, dayNum);
        if (candidate < startOfDay(now)) {
          year += 1;
          candidate = new Date(year, monthIndex, dayNum);
        }
        if (candidate.getMonth() === monthIndex) return toDateString(candidate);
      }
    }
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

export type RelativeShift = { amount: number; unit: 'day' | 'week' | 'month'; direction: 'later' | 'earlier' };

// "a week later", "slipping by two weeks", "pushed back a month" (delays) and
// "moved up a week", "pulled in by two weeks" (pulled earlier) - all phrased
// relative to whatever date is *currently on the record*, not relative to today.
// These must be resolved against the matched project's existing launch_date (see
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
const EARLIER_PATTERN = new RegExp(`\\b(${AMOUNT_ALT})\\s+(day|week|month)s?\\s+earlier\\b`, 'i');
const MOVED_UP_PATTERN = new RegExp(`\\bmoved? up(?: by)?\\s+(${AMOUNT_ALT})\\s+(day|week|month)s?\\b`, 'i');
const PULLED_IN_PATTERN = new RegExp(`\\bpulled? in(?: by)?\\s+(${AMOUNT_ALT})\\s+(day|week|month)s?\\b`, 'i');

const LATER_PATTERNS = [LATER_PATTERN, SLIPPING_PATTERN, PUSHED_BACK_PATTERN];
const EARLIER_PATTERNS = [EARLIER_PATTERN, MOVED_UP_PATTERN, PULLED_IN_PATTERN];

export function parseRelativeShift(raw: string): RelativeShift | null {
  const lower = raw.trim().toLowerCase();
  for (const pattern of LATER_PATTERNS) {
    const match = pattern.exec(lower);
    if (match) {
      return { amount: parseAmount(match[1]), unit: match[2].toLowerCase() as RelativeShift['unit'], direction: 'later' };
    }
  }
  for (const pattern of EARLIER_PATTERNS) {
    const match = pattern.exec(lower);
    if (match) {
      return {
        amount: parseAmount(match[1]),
        unit: match[2].toLowerCase() as RelativeShift['unit'],
        direction: 'earlier',
      };
    }
  }
  return null;
}

/**
 * Applies a relative shift ("a week later", "moved up a week") on top of
 * `baseDateStr` (the project's *current* launch_date, supplied by the caller
 * once a project is matched) rather than on top of today. Like other inferred
 * (non-literal) dates, the result is forced onto a business day. Returns null
 * if `raw` isn't a relative-shift phrase.
 */
export function applyRelativeShift(baseDateStr: string, raw: string): string | null {
  const shift = parseRelativeShift(raw);
  if (!shift) return null;
  const sign = shift.direction === 'earlier' ? -1 : 1;
  const [y, m, d] = baseDateStr.split('-').map(Number);
  const base = new Date(y, m - 1, d);
  if (shift.unit === 'day') base.setDate(base.getDate() + sign * shift.amount);
  else if (shift.unit === 'week') base.setDate(base.getDate() + sign * shift.amount * 7);
  else base.setMonth(base.getMonth() + sign * shift.amount);
  return toDateString(adjustToBusinessDay(base, shift.direction === 'earlier' ? 'backward' : 'forward'));
}
