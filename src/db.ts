import pg from 'pg';
import { runMigrations } from './migrate.ts';
import type { Job, JobStatus, SkipReason } from './types.ts';

export type { FormAnswer, Job, JobStatus, SkipReason } from './types.ts';

/** Every job status, in pipeline order; the dashboard's STATUSES must match (tests/statuses.test.ts). */
export const JOB_STATUSES = ['new', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'skipped', 'filtered'] as const satisfies readonly JobStatus[];

export type ScoredJob = Pick<Job,
  'id' | 'source' | 'company' | 'title' | 'location' | 'country' | 'url' | 'description' | 'score' | 'cluster' |
  'matched' | 'missing' | 'visa' | 'flags' | 'status' | 'filter_reason'> & { posted_at: string | null };

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing — add it to .env');
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

/** Brings the database schema up to date (src/migrations, see src/migrate.ts). Returns the versions applied. */
export const migrate = () => runMigrations(pool);

// Company career pages first (most direct), then big boards, then aggregators.
const SOURCE_RANK = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'linkedin', 'bayt',
  'himalayas', 'remotive', 'remoteok', 'manual'];

export const normCompany = (s: string) => s.toLowerCase()
  .replace(/\.(io|com|ai|co)\b/g, ' ')
  .replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1') // B.V. / N.V. -> bv / nv
  .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|gmbh|bv|b v|nv|fze|fzco|fz llc|group|technologies|technology|tech|holding|holdings|operations|solutions|labs|software|systems|global|international)\b/g, ' ')
  .replace(/[^a-z0-9]/g, '');
export const normTitle = (s: string) => s.toLowerCase()
  .replace(/\([^)]*\)/g, ' ')
  .replace(/\bsr\.?\b/g, 'senior').replace(/full[\s-]?stack/g, 'fullstack').replace(/front[\s-]?end/g, 'frontend').replace(/back[\s-]?end/g, 'backend')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Groups the same posting found on several sites (same company + title + country) and points the copies
 * at one primary row. The primary is the one the user already acted on, else the most direct source.
 */
export async function dedupe() {
  const { rows } = await pool.query<DedupeRow>(
    `SELECT id, company, title, country, source, status, first_seen_at FROM jobs WHERE status <> 'filtered'`);
  const links = duplicateLinks(rows);
  await pool.query('UPDATE jobs SET duplicate_of = NULL WHERE duplicate_of IS NOT NULL');
  if (links.length) {
    await pool.query(`UPDATE jobs SET duplicate_of = v.primary_id FROM unnest($1::text[], $2::text[]) AS v(id, primary_id)
      WHERE jobs.id = v.id`, [links.map((l) => l[0]), links.map((l) => l[1])]);
  }
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
    else [...byCountry.values()].forEach((c, i) => groups.push(i === 0 ? [...c, ...remote] : c));
  }
  const acted = (s: string) => !['new', 'filtered'].includes(s);
  const rank = (s: string) => { const i = SOURCE_RANK.indexOf(s); return i === -1 ? SOURCE_RANK.length : i; };
  const links: [string, string][] = [];
  for (const g of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => Number(acted(b.status)) - Number(acted(a.status)) || rank(a.source) - rank(b.source)
      || new Date(a.first_seen_at).getTime() - new Date(b.first_seen_at).getTime());
    for (const copy of g.slice(1)) links.push([copy.id, g[0].id]);
  }
  return links;
}

/** Inserts new jobs; for existing ones refreshes the posting but never touches user-owned fields (status, cv_version, notes). */
export async function upsertJob(j: ScoredJob): Promise<'inserted' | 'updated'> {
  const { rows } = await pool.query<{ inserted: boolean }>(`
    INSERT INTO jobs (id, source, company, title, location, country, url, description, posted_at,
      score, cluster, matched, missing, visa, flags, status, filter_reason)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title, location = EXCLUDED.location, country = EXCLUDED.country, url = EXCLUDED.url,
      description = EXCLUDED.description, posted_at = EXCLUDED.posted_at, fetched_at = now(),
      score = EXCLUDED.score, cluster = EXCLUDED.cluster, matched = EXCLUDED.matched, missing = EXCLUDED.missing,
      visa = EXCLUDED.visa, flags = EXCLUDED.flags, filter_reason = EXCLUDED.filter_reason,
      -- Re-scoring may move a job between new <-> filtered, but only while the user hasn't acted on it.
      status = CASE WHEN jobs.status IN ('new', 'filtered') THEN EXCLUDED.status ELSE jobs.status END
    RETURNING (xmax = 0) AS inserted`,
    [j.id, j.source, j.company, j.title, j.location, j.country, j.url, j.description, j.posted_at,
      j.score, j.cluster, j.matched, j.missing, j.visa, j.flags, j.status, j.filter_reason]);
  return rows[0].inserted ? 'inserted' : 'updated';
}

export async function getJob(id: string) {
  const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

/** Every skip reason; the dashboard's SKIP_REASONS must match (web/tests/lib/skips.test.ts). */
export const SKIP_REASONS = ['stack', 'seniority', 'salary', 'location', 'company', 'language', 'other'] as const satisfies readonly SkipReason[];

/** Changes a job's status and logs it in job_events, in one transaction. `reason` is kept only for skips. */
export async function setStatus(id: string, status: JobStatus, note?: string, reason?: SkipReason) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [id]);
    // The note belongs to the history entry; jobs.notes is the user's own free-text field (edited in the dashboard).
    await client.query(`UPDATE jobs SET status = $2,
      applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1`, [id, status]);
    await client.query('INSERT INTO job_events (job_id, from_status, to_status, note, reason) VALUES ($1, $2, $3, $4, $5)',
      [id, rows[0]?.status ?? null, status, note ?? null, status === 'skipped' ? reason ?? null : null]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
