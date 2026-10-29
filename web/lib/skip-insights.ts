import { pool } from '@/lib/db';
import type { SkipReason } from '@/lib/skips';

// "Skip patterns" on /analytics: why you skip jobs, and title words that keep showing up in jobs you skipped for
// stack or seniority but never in the ones you kept. Read-only: config.json only changes when you click a
// suggestion (addRoleExclude in app/settings/actions.ts), which re-checks it against these same rules.

/** A word needs at least this many skipped jobs before it is suggested for roleExclude. */
export const MIN_SKIPS = 3;
/** Reasons that mean "the filter should have dropped this title". */
export const TITLE_REASONS: readonly SkipReason[] = ['stack', 'seniority'];

// Words that say nothing about the role itself.
const STOPWORDS = new Set(['and', 'or', 'the', 'of', 'for', 'in', 'at', 'with', 'to', 'an', 'on', 'job', 'team', 'remote',
  'hybrid', 'onsite', 'full', 'time', 'part', 'contract', 'permanent', 'temporary', 'all', 'genders']);

// Each primary job you skipped (and did not move back) with the reason of its latest skip.
const SKIPS = `
  SELECT DISTINCT ON (j.id) j.id, j.title, e.reason
  FROM jobs j JOIN job_events e ON e.job_id = j.id AND e.to_status = 'skipped'
  WHERE j.status = 'skipped' AND j.duplicate_of IS NULL
  ORDER BY j.id, e.at DESC, e.id DESC`;

export type ReasonCount = { reason: SkipReason | null; n: number };

/** Skipped jobs per reason, most common first; `null` = skipped without a reason. */
export async function skipReasonCounts() {
  const { rows } = await pool.query<ReasonCount>(
    `SELECT reason, count(*)::int n FROM (${SKIPS}) s GROUP BY reason ORDER BY n DESC, reason NULLS LAST`);
  return rows;
}

/** Titles of jobs skipped for one of `reasons`, and of every job still in play (not skipped or filtered out). */
export async function skipTitles(reasons: readonly SkipReason[] = TITLE_REASONS) {
  const [skipped, kept] = await Promise.all([
    pool.query<{ title: string }>(`SELECT title FROM (${SKIPS}) s WHERE reason = ANY($1)`, [reasons]),
    pool.query<{ title: string }>(`SELECT title FROM jobs WHERE duplicate_of IS NULL AND status NOT IN ('skipped', 'filtered')`),
  ]);
  return { skipped: skipped.rows.map((r) => r.title), kept: kept.rows.map((r) => r.title) };
}

/** The distinct words of a title: lower case, letters and digits only, no stopwords or bare numbers. */
export function titleWords(title: string): string[] {
  return [...new Set(title.toLowerCase().split(/[^a-z0-9]+/))]
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOPWORDS.has(w));
}

/** `roleExclude` as a RegExp, or null when it is missing or invalid (then nothing counts as covered). */
function compile(roleExclude: string | null | undefined) {
  try {
    return roleExclude ? new RegExp(roleExclude, 'i') : null;
  } catch {
    return null;
  }
}

export type WordCount = { word: string; skips: number };

/**
 * Words in skipped titles that no kept title contains, by how many skipped jobs have them. Words the current
 * roleExclude already matches are left out: those jobs would be filtered now anyway.
 */
export function skipOnlyWords(skipped: string[], kept: string[], roleExclude?: string | null): WordCount[] {
  const keptWords = new Set(kept.flatMap(titleWords));
  const exclude = compile(roleExclude);
  const counts = new Map<string, number>();
  for (const w of skipped.flatMap(titleWords)) {
    if (keptWords.has(w) || exclude?.test(w)) continue;
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts].map(([word, skips]) => ({ word, skips }))
    .sort((a, b) => b.skips - a.skips || a.word.localeCompare(b.word));
}

export type Suggestion = WordCount & { pattern: string };

/**
 * "Add `\bprincipal\b` to roleExclude?" for words with at least `min` skips. Each pattern is a whole-word regex
 * that compiles, matches the word, and matches none of the kept titles, so adding it drops no job you kept.
 */
export function suggestions(words: WordCount[], kept: string[], min = MIN_SKIPS, limit = 5): Suggestion[] {
  const out: Suggestion[] = [];
  for (const w of words) {
    if (w.skips < min || out.length >= limit) continue;
    if (!/^[a-z0-9]+$/.test(w.word)) continue; // only plain words go into a pattern
    const pattern = `\\b${w.word}\\b`;
    const re = new RegExp(pattern, 'i');
    if (re.test(w.word) && !kept.some((t) => re.test(t))) out.push({ ...w, pattern });
  }
  return out;
}

export type SkipInsights = { counts: ReasonCount[]; words: WordCount[]; suggestions: Suggestion[] };

/** Everything the "Skip patterns" section shows, given the current config.json roleExclude. */
export async function skipInsights(roleExclude: string | null | undefined): Promise<SkipInsights> {
  const [counts, { skipped, kept }] = await Promise.all([skipReasonCounts(), skipTitles()]);
  const words = skipOnlyWords(skipped, kept, roleExclude);
  return { counts, words: words.slice(0, 15), suggestions: suggestions(words, kept) };
}
