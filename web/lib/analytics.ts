import { pool } from '@/lib/db';

// Read-only queries for the /analytics page. Copies of a job found on other sites (duplicate_of) never count:
// only the primary row does.

/** Groups with fewer applications than this are shown muted: "1 of 2 = 50%" says little. */
export const MIN_N = 5;

// Funnel stage a status stands for. A later stage implies the earlier ones (an interview means you applied).
const stage = (col: string) =>
  `CASE ${col} WHEN 'prepared' THEN 1 WHEN 'applied' THEN 2 WHEN 'interview' THEN 3 WHEN 'offer' THEN 4 ELSE 0 END`;

/**
 * One row per primary job with the furthest stage it ever reached: its current status, every status in its
 * history (job_events) and applied_at. A job that got an interview and was later rejected still counts as
 * applied and interviewed. `matched` is every job the filters let through, plus any job you acted on.
 */
const REACHED = `
  SELECT id, source, country, cv_version, ai_verdict, status, first_seen_at, stage, status <> 'filtered' OR stage > 0 AS matched
  FROM (
    SELECT j.id, j.source, j.country, j.cv_version, j.ai_verdict, j.status, j.first_seen_at, greatest(${stage('j.status')}, CASE WHEN j.applied_at IS NOT NULL THEN 2 ELSE 0 END,
      coalesce((SELECT max(greatest(${stage('e.to_status')}, ${stage('e.from_status')})) FROM job_events e WHERE e.job_id = j.id), 0)) AS stage
    FROM jobs j WHERE j.duplicate_of IS NULL
  ) r`;

// When you applied: the first move to `applied` in the history (applied_at is reset if the status is set again).
const APPLIED_AT = `coalesce((SELECT min(e.at) FROM job_events e WHERE e.job_id = j.id AND e.to_status = 'applied'), j.applied_at)`;

export type Funnel = {
  matched: number; prepared: number; applied: number; interview: number; offer: number; rejected: number; skipped: number;
};

export async function funnel() {
  const { rows } = await pool.query<Funnel>(`
    SELECT count(*) FILTER (WHERE matched)::int matched, count(*) FILTER (WHERE stage >= 1)::int prepared,
      count(*) FILTER (WHERE stage >= 2)::int applied, count(*) FILTER (WHERE stage >= 3)::int interview,
      count(*) FILTER (WHERE stage >= 4)::int offer, count(*) FILTER (WHERE status = 'rejected')::int rejected,
      count(*) FILTER (WHERE status = 'skipped')::int skipped
    FROM (${REACHED}) r`);
  return rows[0];
}

/** Share of `of` that `n` is, or null when there is nothing to divide by. */
export const rate = (n: number, of: number) => (of > 0 ? n / of : null);

export const DIMENSIONS = ['source', 'country', 'cv_version', 'ai_verdict'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type RateRow = { key: string | null; n: number; responded: number; rate: number; small: boolean };

/** Of the jobs you applied to, how many got an interview or offer, per value of one column. */
export async function responseRates(dim: Dimension): Promise<RateRow[]> {
  // The column name goes into the SQL, so only the known ones are allowed.
  if (!DIMENSIONS.includes(dim)) throw new Error(`Unknown dimension ${dim}`);
  const { rows } = await pool.query<{ key: string | null; n: number; responded: number }>(`
    SELECT ${dim} AS key, count(*)::int n, count(*) FILTER (WHERE stage >= 3)::int responded
    FROM (${REACHED}) r WHERE stage >= 2 GROUP BY 1 ORDER BY n DESC, key NULLS LAST`);
  return rows.map((r) => ({ ...r, rate: r.responded / r.n, small: r.n < MIN_N }));
}

export type WeekRow = { week: Date; applied: number; matches: number };

/** Applications and new matches per week (Monday start), oldest first, the current week included. */
export async function weeklyActivity(weeks = 12) {
  const { rows } = await pool.query<WeekRow>(`
    WITH weeks AS (
      SELECT generate_series(date_trunc('week', now()) - make_interval(weeks => $1 - 1), date_trunc('week', now()), interval '1 week') AS week
    ), applied AS (
      SELECT ${APPLIED_AT} AS at FROM jobs j WHERE j.duplicate_of IS NULL
    ), matches AS (
      SELECT first_seen_at AS at FROM (${REACHED}) r WHERE matched
    )
    SELECT w.week,
      (SELECT count(*) FROM applied a WHERE a.at >= w.week AND a.at < w.week + interval '1 week')::int applied,
      (SELECT count(*) FROM matches m WHERE m.at >= w.week AND m.at < w.week + interval '1 week')::int matches
    FROM weeks w ORDER BY w.week`, [weeks]);
  return rows;
}

/** Days from applying to the first interview or rejection after it, per job that has had a reply. */
export async function responseDays() {
  const { rows } = await pool.query<{ id: string; days: number }>(`
    SELECT id, extract(epoch FROM replied - applied)::float8 / 86400 AS days FROM (
      SELECT j.id, a.applied, (SELECT min(e.at) FROM job_events e
        WHERE e.job_id = j.id AND e.to_status IN ('interview', 'rejected') AND e.at >= a.applied) AS replied
      FROM jobs j CROSS JOIN LATERAL (SELECT ${APPLIED_AT} AS applied) a WHERE j.duplicate_of IS NULL
    ) x WHERE replied IS NOT NULL`);
  return rows;
}

export function median(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type FetchError = { company: string; error: string };
export type FetchRunRow = {
  id: number; started_at: Date; finished_at: Date | null; checked: number; inserted: number; new_matches: number; errors: FetchError[];
};

/** The newest fetch runs, unfinished ones included (a run that crashed never sets finished_at). */
export async function recentFetchRuns(limit = 7) {
  const { rows } = await pool.query<FetchRunRow>(
    'SELECT id, started_at, finished_at, checked, inserted, new_matches, errors FROM fetch_runs ORDER BY id DESC LIMIT $1', [limit]);
  return rows;
}

/** Number of sources that failed in the latest finished fetch (0 when there is none). */
export async function lastFetchErrorCount() {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT jsonb_array_length(errors)::int n FROM fetch_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  return rows[0]?.n ?? 0;
}
