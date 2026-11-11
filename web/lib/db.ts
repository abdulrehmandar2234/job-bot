import { Pool } from 'pg';
// Row types and the follow-up rule come from the bot (talaash/src/types.ts, src/followup.ts).
// .ts extensions: the bot's tests (tests/statuses.test.ts) load this file in plain Node too.
import { FOLLOW_UP_DUE_SQL } from '../../src/followup.ts';
import { currencyCodes, eurRate } from './currencies.ts';
import type { FetchRun, FormAnswer, InterviewPrep, Job as JobRow, JobEvent, SalaryPeriod } from '../../src/types';

// Same Postgres database the CLI bot writes to (talaash/.env and web/.env.local).
const g = globalThis as unknown as { jobBotPool?: Pool };
g.jobBotPool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export const pool = g.jobBotPool;

export const STATUSES = ['new', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'skipped', 'expired', 'filtered'] as const;
export type Status = (typeof STATUSES)[number];

export type { FetchRun, FormAnswer, InterviewPrep, JobEvent };

// listJobs() selects only part of a row, so these columns may be missing.
export type Job = Omit<
  JobRow,
  | 'fetched_at'
  | 'ai_scored_at'
  | 'duplicate_of'
  | 'cover_letter_ai'
  | 'form_answers'
  | 'interview_prep'
  | 'interview_prep_at'
  | 'alerted_at'
  | 'checked_open_at'
  | 'closed_at'
  | 'cover_letter_edited_at'
  | 'cover_letter_ai_error'
  | 'cv_summary'
  | 'cv_summary_at'
  | 'cv_summary_edited_at'
  | 'cv_headline'
  | 'cv_headline_at'
  | 'cv_headline_edited_at'
  | 'cv_template'
  | 'cv_review'
  | 'cv_review_at'
> &
  Partial<
    Pick<
      JobRow,
      | 'duplicate_of'
      | 'cover_letter_ai'
      | 'form_answers'
      | 'interview_prep'
      | 'interview_prep_at'
      | 'alerted_at'
      | 'checked_open_at'
      | 'closed_at'
      | 'cover_letter_edited_at'
      | 'cover_letter_ai_error'
      | 'cv_summary'
      | 'cv_summary_at'
      | 'cv_summary_edited_at'
      | 'cv_headline'
      | 'cv_headline_at'
      | 'cv_headline_edited_at'
      | 'cv_template'
      | 'cv_review'
      | 'cv_review_at'
    >
  >;

// Salaries come in any currency of src/currencies.json and three periods (src/salary.ts). To compare them, everything is
// turned into euros per year. The rates in that table are approximate and fixed on purpose: good enough to filter and
// hint, not for accounting.
export const PER_YEAR: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 }; // 40 h x 52 weeks

/** SQL for a job's best pay (top of its range) in euros per year; NULL without a salary. Built from the rate tables. */
const sqlYearlyEur = () => `(coalesce(salary_max, salary_min)
  * CASE salary_currency ${currencyCodes()
    .map((c) => `WHEN '${c.replace(/[^A-Z]/g, '')}' THEN ${Number(eurRate(c))}`)
    .join(' ')} END
  * CASE salary_period ${Object.entries(PER_YEAR)
    .map(([p, n]) => `WHEN '${p}' THEN ${n}`)
    .join(' ')} END)`;

export type JobFilter = {
  status: Status;
  country?: string;
  min?: number;
  q?: string;
  days?: number;
  sort?: 'score' | 'newest';
  minSalary?: number;
  salaryOnly?: boolean;
  followUp?: boolean; // only applied jobs due a follow-up (src/followup.ts)
  visaOnly?: boolean; // only jobs whose posting offers visa/relocation support, or that need no visa
  everyTab?: boolean; // ignore status: a search across every tab (each card then shows its status)
}; // minSalary: euros per year

/** Jobs per page on the dashboard list: the default, and the choices offered (`?size=`). */
export const PAGE_SIZE = 10;
export const PAGE_SIZES = [10, 25, 50, 100] as const;

/** A `?size=` value if it is one of PAGE_SIZES, else the default. */
export const pageSize = (v: unknown) => (PAGE_SIZES as readonly number[]).find((n) => n === Number(v)) ?? PAGE_SIZE;

/** The WHERE clause and its parameters for a filter, shared by listJobs() and countJobs(). */
function jobWhere(f: JobFilter) {
  // Copies of a job found on other sites are shown as "Posted on" links of the primary, not as rows.
  const where = ['duplicate_of IS NULL'];
  const params: (string | number)[] = [];
  if (f.everyTab) where.push(`(status <> 'filtered' OR country IS NOT NULL)`);
  else {
    params.push(f.status);
    where.push(`status = $${params.length}`);
  }
  if (f.country) {
    params.push(f.country);
    where.push(`country = $${params.length}`);
  }
  // The AI score, once a job has one, is the better judge; the keyword score covers the rest.
  if (f.min) {
    params.push(f.min);
    where.push(`coalesce(ai_score, score) >= $${params.length}`);
  }
  if (f.q) {
    // The search text is matched literally: %, _ and the escape character itself are not wildcards.
    params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(company ILIKE $${params.length} ESCAPE '\\' OR title ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (f.days) {
    params.push(f.days);
    where.push(`coalesce(posted_at, first_seen_at) > now() - make_interval(days => $${params.length})`);
  }
  // Jobs without a salary stay in the list unless salaryOnly asks for jobs that name one.
  if (f.minSalary) {
    params.push(f.minSalary);
    where.push(`(${sqlYearlyEur()} >= $${params.length}${f.salaryOnly ? '' : ' OR salary_currency IS NULL'})`);
  }
  if (f.salaryOnly) where.push('salary_currency IS NOT NULL');
  if (f.visaOnly) where.push(`visa_evidence IN ('offered', 'not-needed')`);
  // Filtered jobs are only useful when they were at least in a target country.
  if (!f.everyTab && f.status === 'filtered') where.push('country IS NOT NULL');
  if (f.followUp) where.push(FOLLOW_UP_DUE_SQL);
  return { where: where.join(' AND '), params };
}

/** The job list's order for a filter, shared by listJobs() and jobNeighbours(). */
function jobOrder(f: JobFilter) {
  const newest = 'coalesce(posted_at, first_seen_at) DESC';
  return f.sort === 'newest'
    ? newest
    : f.followUp
      ? 'coalesce(followed_up_at, applied_at)' // the longest wait first
      : f.everyTab || f.status === 'new' || f.status === 'filtered'
        ? `ai_score DESC NULLS LAST, score DESC, ${newest}`
        : 'coalesce(applied_at, first_seen_at) DESC';
}

/** One page of the job list (1-based; a page past the end is empty). */
export async function listJobs(f: JobFilter, page = 1, pageSize = PAGE_SIZE) {
  const { where, params } = jobWhere(f);
  const order = jobOrder(f);
  params.push(pageSize, (Math.max(1, Math.floor(page)) - 1) * pageSize);
  const { rows } = await pool.query<Job>(
    `SELECT id, source, company, title, location, country, url, '' AS description, posted_at, first_seen_at, score, cluster,
      matched, missing, visa, flags, status, filter_reason, cv_version, NULL AS cover_letter, applied_at, notes,
      ai_score, ai_verdict, ai_summary, ai_reasons, ai_gaps, ai_flags, salary_min, salary_max, salary_currency, salary_period,
      closed_at, follow_ups, followed_up_at, follow_up_draft, visa_evidence
     FROM jobs WHERE ${where} ORDER BY ${order}, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}

/**
 * The jobs before and after one job in the list a filter gives, in the list's order (the job page's Previous / Next),
 * null at either end (both null when the job does not exist).
 *
 * The job itself is always in the window, even when it no longer matches the filter: marking it applied or skipping
 * it moves it out of the list the user came from, and that is exactly when they want Next. It sits where the list's
 * order puts it, so Previous / Next stay the jobs that were around it (a job opened from a list it never was in gets
 * the list's jobs around where it would sort). A status change leaves its place alone in every order but one: a move
 * to applied stamps applied_at, which the applied / skipped / ... tabs sort by, so a job that left the list that way
 * is placed by applied_at as it was before the move (the latest job_events row's prev_applied_at). Sending a follow-up
 * does move a job in the follow-up list (followed_up_at = now() sorts last); the old value is not kept anywhere.
 * lag / lead run over distinct ids, so neither is ever the job itself.
 */
export async function jobNeighbours(f: JobFilter, id: string) {
  const { where, params } = jobWhere(f);
  params.push(id);
  const me = `$${params.length}`;
  const { rows } = await pool.query<{ prev: string | null; next: string | null }>(
    `WITH last AS (
       SELECT job_id, to_status, prev_applied_at FROM job_events WHERE job_id = ${me} ORDER BY at DESC, id DESC LIMIT 1
     )
     SELECT prev, next FROM (
       SELECT id, lag(id) OVER w AS prev, lead(id) OVER w AS next FROM (
         SELECT jobs.id, ai_score, score, posted_at, first_seen_at, followed_up_at,
           CASE WHEN last.to_status = 'applied' AND (${where}) IS NOT TRUE THEN last.prev_applied_at ELSE applied_at END
             AS applied_at
         FROM jobs LEFT JOIN last ON last.job_id = jobs.id
         WHERE (${where}) OR jobs.id = ${me}
       ) jobs WINDOW w AS (ORDER BY ${jobOrder(f)}, id)
     ) t WHERE id = ${me}`,
    params,
  );
  return { prev: rows[0]?.prev ?? null, next: rows[0]?.next ?? null };
}

/** How many jobs match a filter, for the page links. */
export async function countJobs(f: JobFilter) {
  const { where, params } = jobWhere(f);
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE ${where}`, params);
  return rows[0].n;
}

export async function statusCounts() {
  const { rows } = await pool.query<{ status: Status; n: number }>(
    `SELECT status, count(*)::int n FROM jobs WHERE duplicate_of IS NULL AND (status <> 'filtered' OR country IS NOT NULL)
     GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<Status, number>>;
}

/** How many applied jobs are due a follow-up (the "Needs follow-up" tab). */
export async function followUpCount() {
  const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE duplicate_of IS NULL AND ${FOLLOW_UP_DUE_SQL}`);
  return rows[0].n;
}

export type Posting = { id: string; source: string; url: string };

/** Every site a job was found on: the primary row itself plus its duplicates, keyed by primary id. */
export async function postingsFor(ids: string[]) {
  if (!ids.length) return new Map<string, Posting[]>(); // an empty tab needs no query
  const { rows } = await pool.query<Posting & { primary_id: string }>(
    `SELECT coalesce(duplicate_of, id) AS primary_id, id, source, url FROM jobs
     WHERE id = ANY($1) OR duplicate_of = ANY($1) ORDER BY duplicate_of NULLS FIRST, first_seen_at`,
    [ids],
  );
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
    SELECT (SELECT count(*)::int FROM jobs WHERE duplicate_of IS NULL AND applied_at > now() - interval '7 days') AS applied_week,
           (SELECT count(*)::int FROM jobs
            WHERE status <> 'filtered' AND duplicate_of IS NULL AND first_seen_at::date = current_date) AS new_today`);
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
