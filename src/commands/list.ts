import { getJob, pool, type Job } from '../db.ts';
import { row, type Flags } from './shared.ts';

/** list [--status new] [--country AE] [--min 60] [--limit 30] */
export async function list(_args: string[], flags: Flags) {
  const status = flags.status ?? 'new';
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
  params.push(Number(flags.limit ?? 30));
  const { rows: jobs } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY score DESC, posted_at DESC NULLS LAST LIMIT $${params.length}`,
    params,
  );
  if (status === 'filtered') {
    for (const j of jobs) console.log(`${j.company} — ${j.title} (${j.location})\n      ✗ ${j.filter_reason}`);
  } else {
    console.log('score cc  status    company — title  [suggested cv version]');
    for (const j of jobs) console.log(row(j));
  }
  if (!jobs.length) console.log(`No jobs with status=${status}.`);
}

/** show <id> [--full] */
export async function show(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
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
