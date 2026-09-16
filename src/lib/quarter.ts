export function quarterOf(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
}

export function quarterSortKey(q: string): number {
  const m = /^Q(\d) (\d+)$/.exec(q);
  if (!m) return Infinity;
  return Number(m[2]) * 4 + Number(m[1]);
}
