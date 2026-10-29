import { JOB_STATUSES, pool, setStatus, type Job, type JobStatus } from '../db.ts';
import { sleep } from '../sources/http.ts';
import { isOpen, openCheck, type OpenJob, type OpenResult } from '../sources/open.ts';
import type { Flags } from './shared.ts';

/** Statuses a closed posting moves to `expired` from. Later stages are only reported: you are already in the process. */
export const EXPIRABLE: readonly JobStatus[] = ['new', 'prepared'];
const RECHECK_DAYS = 3;

export type CheckJob = OpenJob & Pick<Job, 'status' | 'company' | 'title'>;
export type Outcome = 'open' | 'reopened' | 'expired' | 'reported' | 'unknown';

/** The given jobs, or the primary jobs in `statuses` not checked in the last 3 days (never checked first). */
export async function selectJobs(ids: string[], statuses: string[], limit?: number): Promise<CheckJob[]> {
  const cols = 'id, source, url, status, company, title';
  if (ids.length) {
    const { rows } = await pool.query<CheckJob>(`SELECT ${cols} FROM jobs WHERE id = ANY($1)`, [ids]);
    return ids.flatMap((id) => rows.filter((r) => r.id === id));
  }
  const { rows } = await pool.query<CheckJob>(
    `SELECT ${cols} FROM jobs
    WHERE status = ANY($1) AND duplicate_of IS NULL
      AND (checked_open_at IS NULL OR checked_open_at < now() - make_interval(days => $2))
    ORDER BY checked_open_at NULLS FIRST, coalesce(ai_score, score) DESC, id
    LIMIT $3`,
    [statuses, RECHECK_DAYS, limit ?? null],
  );
  return rows;
}

const hostOf = (job: OpenJob) => {
  try {
    return new URL(openCheck(job).url).host;
  } catch {
    return job.url;
  }
};

/**
 * Runs `check` for every job, at most `concurrency` at a time, and waits `delayMs` between two requests to the same
 * host. Results keep the order of `jobs`.
 */
export async function checkAll<T extends OpenJob, R>(
  jobs: T[],
  check: (job: T) => Promise<R>,
  { concurrency = 2, delayMs = 2000, wait = sleep } = {},
): Promise<R[]> {
  const nextAt = new Map<string, number>(); // host → earliest start of its next request
  const out: R[] = new Array(jobs.length);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const n = i++;
      const host = hostOf(jobs[n]);
      const now = Date.now();
      const at = Math.max(now, nextAt.get(host) ?? 0);
      nextAt.set(host, at + delayMs);
      if (at > now) await wait(at - now);
      out[n] = await check(jobs[n]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return out;
}

/**
 * Stores a check result. A closed posting moves a new/prepared job to `expired` through the normal status change
 * (with a job_events note); a job you already applied to keeps its status. An unknown result changes nothing, so
 * the job is checked again next run. A job this check expired earlier goes back to its old status if it is open again.
 */
export async function record(job: CheckJob, r: OpenResult): Promise<Outcome> {
  if (r.state === 'unknown') return 'unknown';
  const isClosed = r.state === 'closed';
  await pool.query(
    `UPDATE jobs SET checked_open_at = now(),
    closed_at = CASE WHEN $2 THEN coalesce(closed_at, now()) ELSE NULL END WHERE id = $1`,
    [job.id, isClosed],
  );
  if (isClosed) {
    if (!EXPIRABLE.includes(job.status)) return job.status === 'expired' ? 'expired' : 'reported';
    await setStatus(job.id, 'expired', `posting closed (${r.reason})`);
    return 'expired';
  }
  if (job.status !== 'expired') return 'open';
  const { rows } = await pool.query<{ from_status: JobStatus | null; note: string | null }>(
    `SELECT from_status, note
    FROM job_events WHERE job_id = $1 AND to_status = 'expired' ORDER BY at DESC, id DESC LIMIT 1`,
    [job.id],
  );
  // Only undo the bot's own verdict; a job you marked expired yourself stays expired.
  if (!rows[0]?.note?.startsWith('posting closed')) return 'open';
  const back = rows[0].from_status && EXPIRABLE.includes(rows[0].from_status) ? rows[0].from_status : 'new';
  await setStatus(job.id, back, `posting open again (${r.reason})`);
  job.status = back;
  return 'reopened';
}

const LINE: Record<Outcome, string> = {
  open: '✓ open    ',
  reopened: '↺ reopened',
  expired: '✗ expired ',
  reported: '! closed  ',
  unknown: '? unknown ',
};

/** check:open [<id>...] [--status new,prepared] [--limit N]: marks postings that have closed as `expired`. */
export async function checkOpen(args: string[], flags: Flags) {
  const statuses = (flags.status ?? 'new,prepared')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (statuses.some((s) => !JOB_STATUSES.includes(s as JobStatus)) || (limit !== undefined && !(Number.isInteger(limit) && limit > 0))) {
    console.log(`Usage: check:open [<id>...] [--status ${JOB_STATUSES.join(',')}] [--limit N]`);
    process.exitCode = 1;
    return;
  }
  const jobs = await selectJobs(args, statuses, limit);
  const missing = args.filter((id) => !jobs.some((j) => j.id === id));
  for (const id of missing) console.log(`Not found: ${id}`);
  if (!jobs.length) return console.log('No postings to check.');

  console.log(`Checking ${jobs.length} posting${jobs.length === 1 ? '' : 's'}…`);
  const counts: Record<Outcome, number> = { open: 0, reopened: 0, expired: 0, reported: 0, unknown: 0 };
  await checkAll(jobs, async (job) => {
    const r = await isOpen(job);
    const outcome = await record(job, r);
    counts[outcome]++;
    // Open postings are only listed when you asked for specific jobs; the rest always are.
    if (outcome !== 'open' || args.length) {
      const kept =
        outcome !== 'reported'
          ? ''
          : ` — status ${job.status} kept${['applied', 'interview', 'offer'].includes(job.status) ? ', you are already in the process' : ''}`;
      console.log(`${LINE[outcome]} ${job.company} — ${job.title} (${r.reason})${kept}\n      id: ${job.id}`);
    }
  });
  console.log(
    `\n${jobs.length} checked: ${counts.open + counts.reopened} open${counts.reopened ? ` (${counts.reopened} reopened)` : ''}, ` +
      `${counts.expired} closed → expired, ${counts.reported} closed but status kept, ` +
      `${counts.unknown} unknown (checked again next run).`,
  );
}
