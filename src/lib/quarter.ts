// Parses the YYYY-MM-DD components directly rather than `new Date(dateStr)`: a
// date-only string is parsed by the JS spec as UTC midnight, and reading it back
// with local getters (getMonth/getFullYear) in any timezone behind UTC rolls it
// back into the previous day - which, for a date that's the 1st of a month,
// silently lands it in the wrong month/quarter entirely. Working on the string's
// own digits sidesteps timezone conversion altogether.
export function quarterOf(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return 'Unknown';
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return 'Unknown';
  return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
}

export function quarterSortKey(q: string): number {
  const m = /^Q(\d) (\d+)$/.exec(q);
  if (!m) return Infinity;
  return Number(m[2]) * 4 + Number(m[1]);
}
