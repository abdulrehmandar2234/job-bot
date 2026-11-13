import { getJob, JOB_STATUSES, pool, type Job, type JobStatus } from '../db.ts';
import { row, type Flags, notFound, usage } from './shared.ts';

/**
 * The fields `list --json` gives per job: what a script or AI agent needs to pick a job, without the long texts
 * (`show <id> --json` has the whole row). Dates are ISO strings.
 */
export const LIST_FIELDS = [
  'id',
  'source',
  'company',
  'title',
  'location',
  'country',
  'url',
  'status',
  'score',
  'ai_score',
  'ai_verdict',
  'cluster',
  'matched',
  'missing',
  'visa',
  'visa_evidence',
  'flags',
  'filter_reason',
  'salary_min',
  'salary_max',
  'salary_currency',
  'salary_period',
  'deadline',
  'posted_at',
  'first_seen_at',
  'applied_at',
  'cv_version',
  'duplicate_of',
] as const satisfies readonly (keyof Job)[];

export type ListItem = Pick<Job, (typeof LIST_FIELDS)[number]>;

export const listItem = (j: Job): ListItem => Object.fromEntries(LIST_FIELDS.map((k) => [k, j[k]])) as ListItem;

/** list [--status new] [--country AE] [--min 60] [--limit 30] [--json] */
export async function list(_args: string[], flags: Flags) {
  const status = flags.status ?? 'new';
  if (!JOB_STATUSES.includes(status as JobStatus))
    return usage(`list [--status ${JOB_STATUSES.join('|')}] [--country NL] [--min 60] [--limit 30] [--json]`);
  const limit = Number(flags.limit ?? 30);
  if (!Number.isInteger(limit) || limit < 1) return usage('list [--limit N]: N is a whole number of at least 1');
  const where = ['status = $1'];
  const params: (string | number)[] = [status];
  if (flags.country) {
    params.push(flags.country.toUpperCase());
    where.push(`country = $${params.length}`);
  }
  if (flags.min) {
    params.push(Number(flags.min));
    where.push(`score >= $${params.length}`);
  }
  params.push(limit);
  const { rows: jobs } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY score DESC, posted_at DESC NULLS LAST LIMIT $${params.length}`,
    params,
  );
  if (flags.json) return console.log(JSON.stringify(jobs.map(listItem)));
  if (status === 'filtered') {
    for (const j of jobs) console.log(`${j.company} — ${j.title} (${j.location})\n      ✗ ${j.filter_reason}`);
  } else {
    console.log('score cc  status    company — title  [suggested cv version]');
    for (const j of jobs) console.log(row(j));
  }
  if (!jobs.length) console.log(`No jobs with status=${status}.`);
}

/** show <id> [--full] [--json]: --json prints the whole row (the description, letter and answers too). */
export async function show(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return notFound();
  if (flags.json) return console.log(JSON.stringify(j));
  console.log(`${j.company} — ${j.title}\n${j.location} (${j.country ?? '?'})\n${j.url}\n`);
  console.log(`Score ${j.score} | status ${j.status} | CV cluster ${j.cluster} | CV version ${j.cv_version ?? '-'}`);
  console.log(`Visa: ${j.visa ?? 'unknown'}`);
  console.log(`Matched: ${j.matched.join(', ')}`);
  console.log(`Missing: ${j.missing.join(', ') || '-'}`);
  if (j.flags.length) console.log(`Flags: ${j.flags.join('; ')}`);
  if (j.filter_reason) console.log(`Filtered: ${j.filter_reason}`);
  if (j.notes) console.log(`Notes: ${j.notes}`);
  if (flags.full) console.log(`\n${j.description}`);
}

export async function stats() {
  const { rows } = await pool.query<{ status: string; country: string | null; n: number }>(
    'SELECT status, country, count(*)::int n FROM jobs GROUP BY status, country ORDER BY status, country',
  );
  for (const r of rows) console.log(`${r.status.padEnd(10)} ${(r.country ?? '--').padEnd(3)} ${r.n}`);
}
