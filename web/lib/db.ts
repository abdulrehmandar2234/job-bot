import { Pool } from 'pg';

// Same Postgres database the CLI bot writes to (job-bot/.env and web/.env.local).
const g = globalThis as unknown as { jobBotPool?: Pool };
export const pool = (g.jobBotPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 }));

export const STATUSES = ['new', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'skipped', 'filtered'] as const;
export type Status = (typeof STATUSES)[number];

export type Job = {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  country: string | null;
  url: string;
  description: string;
  posted_at: Date | null;
  first_seen_at: Date;
  score: number;
  cluster: string | null;
  matched: string[];
  missing: string[];
  visa: string | null;
  flags: string[];
  status: Status;
  filter_reason: string | null;
  cv_version: string | null;
  cover_letter: string | null;
  applied_at: Date | null;
  notes: string | null;
  duplicate_of?: string | null;
  ai_score: number | null;
  ai_verdict: string | null;
  ai_summary: string | null;
  ai_reasons: string[] | null;
  ai_gaps: string[] | null;
  ai_flags: string[] | null;
  cover_letter_ai?: boolean;
  form_answers?: FormAnswer[];
};

export type FormAnswer = { question: string; answer: string; needs_input: boolean; note: string };

export type JobEvent = { id: number; at: Date; from_status: string | null; to_status: string; note: string | null };
export type FetchRun = { started_at: Date; finished_at: Date | null; checked: number; inserted: number; new_matches: number };

export type JobFilter = { status: Status; country?: string; min?: number; q?: string; days?: number; sort?: 'score' | 'newest' };

export async function listJobs(f: JobFilter) {
  // Copies of a job found on other sites are shown as "Posted on" links of the primary, not as rows.
  const where = ['status = $1', 'duplicate_of IS NULL'];
  const params: (string | number)[] = [f.status];
  if (f.country) { params.push(f.country); where.push(`country = $${params.length}`); }
  // The AI score, once a job has one, is the better judge; the keyword score covers the rest.
  if (f.min) { params.push(f.min); where.push(`coalesce(ai_score, score) >= $${params.length}`); }
  if (f.q) { params.push(`%${f.q}%`); where.push(`(company ILIKE $${params.length} OR title ILIKE $${params.length})`); }
  if (f.days) { params.push(f.days); where.push(`coalesce(posted_at, first_seen_at) > now() - make_interval(days => $${params.length})`); }
  // Filtered jobs are only useful when they were at least in a target country.
  if (f.status === 'filtered') where.push('country IS NOT NULL');
  const newest = 'coalesce(posted_at, first_seen_at) DESC';
  const order = f.sort === 'newest' ? newest
    : f.status === 'new' || f.status === 'filtered' ? `ai_score DESC NULLS LAST, score DESC, ${newest}`
    : 'coalesce(applied_at, first_seen_at) DESC';
  const { rows } = await pool.query<Job>(
    `SELECT id, source, company, title, location, country, url, '' AS description, posted_at, first_seen_at, score, cluster,
      matched, missing, visa, flags, status, filter_reason, cv_version, NULL AS cover_letter, applied_at, notes,
      ai_score, ai_verdict, ai_summary, ai_reasons, ai_gaps, ai_flags
     FROM jobs WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
  return rows;
}

export async function statusCounts() {
  const { rows } = await pool.query<{ status: Status; n: number }>(
    `SELECT status, count(*)::int n FROM jobs WHERE duplicate_of IS NULL AND (status <> 'filtered' OR country IS NOT NULL)
     GROUP BY status`);
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<Status, number>>;
}

export type Posting = { id: string; source: string; url: string };

/** Every site a job was found on: the primary row itself plus its duplicates, keyed by primary id. */
export async function postingsFor(ids: string[]) {
  const { rows } = await pool.query<Posting & { primary_id: string }>(
    `SELECT coalesce(duplicate_of, id) AS primary_id, id, source, url FROM jobs
     WHERE id = ANY($1) OR duplicate_of = ANY($1) ORDER BY duplicate_of NULLS FIRST, first_seen_at`, [ids]);
  const map = new Map<string, Posting[]>();
  for (const r of rows) map.set(r.primary_id, [...(map.get(r.primary_id) ?? []), { id: r.id, source: r.source, url: r.url }]);
  return map;
}

export async function lastRun() {
  const { rows } = await pool.query<FetchRun>('SELECT * FROM fetch_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1');
  return rows[0] ?? null;
}

export async function weekStats() {
  const { rows } = await pool.query<{ applied_week: number; new_today: number }>(`
    SELECT (SELECT count(*)::int FROM jobs WHERE applied_at > now() - interval '7 days') AS applied_week,
           (SELECT count(*)::int FROM jobs WHERE status <> 'filtered' AND first_seen_at::date = current_date) AS new_today`);
  return rows[0];
}

export async function getJob(id: string) {
  const { rows } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function jobEvents(id: string) {
  const { rows } = await pool.query<JobEvent>('SELECT * FROM job_events WHERE job_id = $1 ORDER BY at DESC', [id]);
  return rows;
}
