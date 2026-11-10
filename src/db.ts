import pg from 'pg';
import { normCompany } from './contacts.ts';
import { FOLLOW_UP_DUE_SQL } from './followup.ts';
import { runMigrations } from './migrate.ts';
import { UserError } from './errors.ts';
import type { Job, JobStatus, SkipReason } from './types.ts';

export type { FormAnswer, Job, JobStatus, SkipReason } from './types.ts';
export { SKIP_REASONS } from './types.ts';
export { normCompany };

/** Every job status, in pipeline order; the dashboard's STATUSES must match (tests/statuses.test.ts). */
export const JOB_STATUSES = [
  'new',
  'prepared',
  'applied',
  'interview',
  'offer',
  'rejected',
  'skipped',
  'expired',
  'filtered',
] as const satisfies readonly JobStatus[];

export type ScoredJob = Pick<
  Job,
  | 'id'
  | 'source'
  | 'company'
  | 'title'
  | 'location'
  | 'country'
  | 'url'
  | 'description'
  | 'score'
  | 'cluster'
  | 'matched'
  | 'missing'
  | 'visa'
  | 'flags'
  | 'status'
  | 'filter_reason'
> & { posted_at: string | null } & Partial<
    Pick<Job, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period' | 'visa_evidence'>
  > & {
    /** false: scored again from the stored row (rescore, check:open), not seen by a fetch, so fetched_at stays. */
    seen?: boolean;
  };

let realPool: pg.Pool | null = null;

/**
 * The connection pool, created on first use rather than at import time, so commands and modules that never query
 * (help, settings checks, a module the dashboard imports) still load without DATABASE_URL. Throws a UserError when
 * DATABASE_URL is not set, which the CLI prints as one line.
 */
export function getPool(): pg.Pool {
  if (!realPool) {
    if (!process.env.DATABASE_URL) throw new UserError('DATABASE_URL is not set: put it in .env in the job-bot folder');
    realPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  }
  return realPool;
}

/**
 * The shared pool: every property is read from getPool(), so the first query creates it. `end()` on a pool that was
 * never created is a no-op (a `finally { pool.end() }` after a failed start must not hide the first error).
 */
export const pool: pg.Pool = new Proxy(Object.create(pg.Pool.prototype) as pg.Pool, {
  get(_t, p) {
    if (p === 'end' && !realPool) return async () => {};
    const real = getPool();
    const v = Reflect.get(real, p, real) as unknown;
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
  set(_t, p, v) {
    return Reflect.set(getPool(), p, v);
  },
});

/** Brings the database schema up to date (src/migrations, see src/migrate.ts). Returns the versions applied. */
export const migrate = () => runMigrations(pool);

/**
 * Runs `fn` while holding a Postgres session advisory lock named `job_bot:<name>`, on a client of its own, so two
 * processes (the dashboard's task and the launchd script, say) never run the same command at once. Returns false
 * without running `fn` when another session holds the lock. The lock is released when `fn` ends, or with the session.
 */
export async function withLock(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext('job_bot:' || $1)) AS locked`, [name]);
    if (!rows[0].locked) return false;
    try {
      await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('job_bot:' || $1))`, [name]).catch((e: Error) => {
        broken = e;
      });
    }
    return true;
  } finally {
    // A client whose unlock failed is closed rather than reused, which drops the lock with the session.
    client.release(broken);
  }
}

// Company career pages first (most direct), then big boards, then aggregators.
const SOURCE_RANK = [
  'greenhouse',
  'lever',
  'ashby',
  'recruitee',
  'workable',
  'smartrecruiters',
  'linkedin',
  'bayt',
  'himalayas',
  'remotive',
  'remoteok',
  'manual',
];

export const normTitle = (s: string) =>
  s
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bsr\.?\b/g, 'senior')
    .replace(/full[\s-]?stack/g, 'fullstack')
    .replace(/front[\s-]?end/g, 'frontend')
    .replace(/back[\s-]?end/g, 'backend')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Groups the same posting found on several sites (same company + title + country) and points the copies
 * at one primary row. The primary is the one the user already acted on, else the most direct source.
 */
export async function dedupe() {
  const { rows } = await pool.query<DedupeRow>(
    `SELECT id, company, title, country, source, status, first_seen_at FROM jobs WHERE status <> 'filtered'`,
  );
  const links = duplicateLinks(rows);
  // Only rows whose link changes are written: every grouped row gets its primary, and a row still linked but no
  // longer in a group (or now filtered) gets NULL. It is one statement, so a reader never sees a half-done relink; an
  // unchanged grouping writes nothing, so a concurrent fetch's upserts never wait on locks of rows that did not change.
  await pool.query(
    `WITH wanted AS (SELECT * FROM unnest($1::text[], $2::text[]) AS v(id, primary_id))
    UPDATE jobs SET duplicate_of = w.primary_id
      FROM (
        SELECT j.id, wanted.primary_id FROM jobs j LEFT JOIN wanted ON wanted.id = j.id
        WHERE wanted.id IS NOT NULL OR j.duplicate_of IS NOT NULL
      ) w
     WHERE jobs.id = w.id AND jobs.duplicate_of IS DISTINCT FROM w.primary_id`,
    [links.map((l) => l[0]), links.map((l) => l[1])],
  );
  return links.length;
}

export type DedupeRow = Pick<Job, 'id' | 'company' | 'title' | 'country' | 'source' | 'status' | 'first_seen_at'>;

/** [copy id, primary id] pairs for every posting found more than once. */
export function duplicateLinks(rows: DedupeRow[]): [string, string][] {
  const byPosting = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${normCompany(r.company)}|${normTitle(r.title)}`;
    byPosting.set(key, [...(byPosting.get(key) ?? []), r]);
  }
  // Same title in two real countries = two jobs. A remote ('RM') copy joins the onsite one,
  // since boards often tag a remote role with the company's office city.
  const groups: (typeof rows)[] = [];
  for (const g of byPosting.values()) {
    const byCountry = new Map<string, typeof rows>();
    for (const r of g) if (r.country !== 'RM') byCountry.set(r.country ?? '', [...(byCountry.get(r.country ?? '') ?? []), r]);
    const remote = g.filter((r) => r.country === 'RM');
    if (!byCountry.size) groups.push(remote);
    else for (const [i, c] of [...byCountry.values()].entries()) groups.push(i === 0 ? [...c, ...remote] : c);
  }
  // `expired` is the bot's verdict, not the user's: a still-open copy becomes primary, so the job stays in Matching.
  const acted = (s: string) => !['new', 'filtered', 'expired'].includes(s);
  const expired = (s: string) => Number(s === 'expired');
  const rank = (s: string) => {
    const i = SOURCE_RANK.indexOf(s);
    return i === -1 ? SOURCE_RANK.length : i;
  };
  const links: [string, string][] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    g.sort(
      (a, b) =>
        Number(acted(b.status)) - Number(acted(a.status)) ||
        expired(a.status) - expired(b.status) ||
        rank(a.source) - rank(b.source) ||
        new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime(),
    );
    for (const copy of g.slice(1)) links.push([copy.id, g[0].id]);
  }
  return links;
}

/**
 * Inserts new jobs; for existing ones refreshes the posting but never touches user-owned fields (status, cv_version, notes).
 * fetched_at means "last seen by a fetch": it moves only when `seen` is not false.
 */
export async function upsertJob(j: ScoredJob): Promise<'inserted' | 'updated'> {
  const { rows } = await pool.query<{ inserted: boolean }>(
    `
    INSERT INTO jobs (id, source, company, title, location, country, url, description, posted_at,
      score, cluster, matched, missing, visa, flags, status, filter_reason,
      salary_min, salary_max, salary_currency, salary_period, visa_evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title, location = EXCLUDED.location, country = EXCLUDED.country, url = EXCLUDED.url,
      description = EXCLUDED.description, posted_at = EXCLUDED.posted_at,
      fetched_at = CASE WHEN $23 THEN now() ELSE jobs.fetched_at END,
      score = EXCLUDED.score, cluster = EXCLUDED.cluster, matched = EXCLUDED.matched, missing = EXCLUDED.missing,
      visa = EXCLUDED.visa, visa_evidence = EXCLUDED.visa_evidence, flags = EXCLUDED.flags,
      -- A job the AI review found closed to the candidate's location stays filtered, whatever the keyword rules say.
      filter_reason = CASE WHEN EXCLUDED.status = 'new' AND jobs.ai_location = 'no'
        THEN left('location (AI): ' || coalesce(jobs.ai_location_reason, 'not open to where you live'), 300)
        ELSE EXCLUDED.filter_reason END,
      salary_min = EXCLUDED.salary_min, salary_max = EXCLUDED.salary_max,
      salary_currency = EXCLUDED.salary_currency, salary_period = EXCLUDED.salary_period,
      -- Re-scoring may move a job between new <-> filtered, but only while the user hasn't acted on it.
      status = CASE WHEN jobs.status NOT IN ('new', 'filtered') THEN jobs.status
        WHEN EXCLUDED.status = 'new' AND jobs.ai_location = 'no' THEN 'filtered'
        ELSE EXCLUDED.status END
    RETURNING (xmax = 0) AS inserted`,
    [
      j.id,
      j.source,
      j.company,
      j.title,
      j.location,
      j.country,
      j.url,
      j.description,
      j.posted_at,
      j.score,
      j.cluster,
      j.matched,
      j.missing,
      j.visa,
      j.flags,
      j.status,
      j.filter_reason,
      j.salary_min ?? null,
      j.salary_max ?? null,
      j.salary_currency ?? null,
      j.salary_period ?? null,
      j.visa_evidence ?? null,
      j.seen !== false,
    ],
  );
  return rows[0].inserted ? 'inserted' : 'updated';
}

/** Filtered postings stay at least this many days (or twice maxAgeDays, if longer) before pruneFiltered deletes them. */
export const PRUNE_FILTERED_MIN_DAYS = 30;
/** ...and only once no fetch has seen them for this many days: a posting still listed would come back as "new". */
export const PRUNE_FILTERED_UNSEEN_DAYS = 7;

/**
 * Deletes filtered jobs nobody needs any more, so their descriptions stop filling the table, rescore and every backup:
 * posted (or, without a date, first seen) more than max(maxAgeDays * 2, 30) days ago, not seen by a fetch for 7 days,
 * with no history, contacts or tasks, and not the primary of another row. Returns how many went.
 */
export async function pruneFiltered(maxAgeDays: number, db: Pick<pg.Pool, 'query'> = pool): Promise<number> {
  const days = Math.max(maxAgeDays * 2, PRUNE_FILTERED_MIN_DAYS);
  const { rowCount } = await db.query(
    `DELETE FROM jobs j WHERE j.status = 'filtered'
      AND coalesce(j.posted_at, j.first_seen_at) < now() - make_interval(days => $1::int)
      AND j.fetched_at < now() - make_interval(days => $2::int)
      AND NOT EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = j.id)
      AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.job_id = j.id)
      AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.job_id = j.id)
      AND NOT EXISTS (SELECT 1 FROM jobs d WHERE d.duplicate_of = j.id)`,
    [days, PRUNE_FILTERED_UNSEEN_DAYS],
  );
  return rowCount ?? 0;
}

export async function getJob(id: string) {
  const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

/**
 * Changes a job's status and logs it in job_events, in one transaction. `reason` is kept only for skips. With `expectFrom`, the change only applies when the current
 * status (read under a row lock) is one of those statuses: bot steps pass the statuses they decided from, so a status
 * the user set in the meantime is never overwritten. With `set`, the extra columns change in the same transaction
 * (and not at all when the change is refused), so a crash can never leave a status without its matching reason.
 * Returns whether the status was changed.
 */
export async function setStatus(
  id: string,
  status: JobStatus,
  note?: string,
  reason?: SkipReason,
  { expectFrom, set }: { expectFrom?: readonly JobStatus[]; set?: { filter_reason?: string | null } } = {},
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: JobStatus }>('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [id]);
    if (expectFrom && !(rows[0] && expectFrom.includes(rows[0].status))) {
      await client.query('ROLLBACK');
      return false;
    }
    // The note belongs to the history entry; jobs.notes is the user's own free-text field (edited in the dashboard).
    await client.query(
      `UPDATE jobs SET status = $2,
      applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1`,
      [id, status],
    );
    if (set && 'filter_reason' in set) await client.query('UPDATE jobs SET filter_reason = $2 WHERE id = $1', [id, set.filter_reason]);
    await client.query('INSERT INTO job_events (job_id, from_status, to_status, note, reason) VALUES ($1, $2, $3, $4, $5)', [
      id,
      rows[0]?.status ?? null,
      status,
      note ?? null,
      status === 'skipped' ? (reason ?? null) : null,
    ]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---- Follow-ups (the rule itself is in followup.ts) ----

/** Applied jobs due a follow-up, the longest wait first. */
export async function dueFollowUps(): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE duplicate_of IS NULL AND ${FOLLOW_UP_DUE_SQL} ORDER BY coalesce(followed_up_at, applied_at)`,
  );
  return rows;
}

/** Records that the user sent a follow-up: counts it and logs it in the job's history. Returns the new count. */
export async function markFollowedUp(id: string): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ follow_ups: number; status: string }>(
      `UPDATE jobs SET follow_ups = follow_ups + 1, followed_up_at = now() WHERE id = $1 RETURNING follow_ups, status`,
      [id],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('INSERT INTO job_events (job_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)', [
      id,
      rows[0].status,
      `Follow-up ${rows[0].follow_ups} sent`,
    ]);
    await client.query('COMMIT');
    return rows[0].follow_ups;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
