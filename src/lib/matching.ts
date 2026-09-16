import type { Launch } from './types';

export type MatchTier = 'high' | 'candidates' | 'new';

export interface MatchResult {
  tier: MatchTier;
  // For 'high': the single best match. For 'candidates': ranked list. For 'new': similar (but not matching) projects to surface as a notice.
  matches: Array<{ launch: Launch; score: number }>;
}

// Simple, dependency-free string similarity (normalized Levenshtein-based ratio).
// Good enough for a POC; a production version would use a real fuzzy-match library
// (e.g. fuse.js, or a proper trigram/embedding similarity) - noted in README.
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  const normA = a.toLowerCase().trim();
  const normB = b.toLowerCase().trim();
  if (!normA || !normB) return 0;
  const dist = levenshtein(normA, normB);
  const maxLen = Math.max(normA.length, normB.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

// Token-overlap similarity - complements Levenshtein for longer text like Project Brief,
// where word order/length varies more than for short project names.
function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().match(/\w+/g) ?? []);
  const tokensB = new Set(b.toLowerCase().match(/\w+/g) ?? []);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  return overlap / Math.max(tokensA.size, tokensB.size);
}

/**
 * Combined score: weight Project name similarity higher than Project Brief,
 * since the name is the more deliberate identifier; brief similarity is a
 * secondary signal (people phrase briefs differently even for the same project).
 */
function combinedScore(
  candidateName: string,
  candidateBrief: string,
  inputName: string,
  inputBrief: string
): number {
  const nameScore = similarity(candidateName, inputName);
  const briefScore = tokenOverlap(candidateBrief, inputBrief);
  return nameScore * 0.7 + briefScore * 0.3;
}

// Name-only similarity is enough on its own to be confident this is the *same*
// project referenced again - unlike the general matcher, it deliberately ignores
// brief overlap, since a status-correction message ("X is back in progress") won't
// share vocabulary with the project's original brief.
const TERMINAL_NAME_MATCH_THRESHOLD = 0.85;

// Statuses that mean a project is done, one way or another - a lookalike message
// is far more likely to be a new project than a Shipped launch reopening or a
// Cancelled one un-cancelling.
const TERMINAL_STATUSES = new Set(['Shipped', 'Cancelled']);

/**
 * Matching Logic (locked design):
 * - Excludes projects with a terminal status (Shipped, Cancelled) from the general
 *   similarity matcher (treated as if no match exists) - EXCEPT a near-exact
 *   project-name match (see TERMINAL_NAME_MATCH_THRESHOLD) still surfaces as a
 *   candidate, so a wrongly-terminal project can be corrected via chat instead of
 *   becoming permanently unreachable.
 * - score >= 0.80 -> 'high' tier: single recommended match
 * - 0.35 <= score < 0.80 -> 'candidates' tier: multiple candidates shown
 * - score < 0.35 -> 'new' tier: create as new, but surface similar projects as a non-blocking notice
 */
export function matchProject(
  inputName: string,
  inputBrief: string,
  existing: Launch[]
): MatchResult {
  const eligible = existing.filter((l) => !TERMINAL_STATUSES.has(l.status));

  const scored = eligible
    .map((launch) => ({
      launch,
      score: combinedScore(launch.project, launch.project_brief, inputName, inputBrief),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  if (best && best.score >= 0.8) {
    return { tier: 'high', matches: [best] };
  }

  // A shortened reference ("SharePoint connector") that's a substantial, unique
  // substring of exactly one eligible project's full name ("SharePoint connector for
  // document storage") is confidently the same project - people naturally drop
  // trailing descriptive words when referring to something again, and the
  // Levenshtein/token-overlap scorer above penalizes that length difference even
  // though there's no real ambiguity. Only promotes when the containment is unique:
  // a generic word like "connector" alone will contain-match several projects and
  // correctly falls through to the candidates tier instead.
  const normInput = inputName.toLowerCase().trim();
  if (normInput.length >= 6) {
    const containmentMatches = eligible.filter((l) => l.project.toLowerCase().includes(normInput));
    if (containmentMatches.length === 1) {
      return { tier: 'high', matches: [{ launch: containmentMatches[0], score: 0.85 }] };
    }
  }

  const terminalNameMatches = existing
    .filter((l) => TERMINAL_STATUSES.has(l.status))
    .map((launch) => ({ launch, score: similarity(launch.project, inputName) }))
    .filter((s) => s.score >= TERMINAL_NAME_MATCH_THRESHOLD);

  const candidates = [...scored.filter((s) => s.score >= 0.35 && s.score < 0.8), ...terminalNameMatches].sort(
    (a, b) => b.score - a.score
  );
  if (candidates.length > 0) {
    return { tier: 'candidates', matches: candidates.slice(0, 5) };
  }

  // 'new' tier - still surface anything mildly similar as an FYI, but only above the
  // noise floor: unrelated name/brief pairs commonly score ~0.12-0.22 just from
  // coincidental letter/word overlap, while genuinely related-but-not-matching names
  // (sharing a real word, e.g. "connector" or "contract") land ~0.25+. 0.25 is the
  // measured cutoff that separates the two (see combinedScore/matchProject).
  const similarButNotMatching = scored.filter((s) => s.score >= 0.25 && s.score < 0.35).slice(0, 3);
  return { tier: 'new', matches: similarButNotMatching };
}
