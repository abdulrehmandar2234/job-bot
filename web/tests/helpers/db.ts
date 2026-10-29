import { pool } from '@/lib/db';
// The bot's own migration runner (vitest can import bot code; the dashboard build never does).
import { runMigrations } from '../../../src/migrate';
import type { Job } from '../../../src/types';

// job_bot_test is shared with the bot's own tests: only touch rows with this id prefix, and fetch_runs we inserted.
export const PREFIX = 'webtest:';
const fetchRunIds: number[] = [];

/** Applies the bot's migrations (src/migrations); an advisory lock keeps parallel test runs from racing. */
export async function ensureSchema() {
  await runMigrations(pool);
}

/** A jobs row to insert: any columns of the shared Job type, `id` required. */
export type JobRow = { id: string } & Partial<Omit<Job, 'id'>>;

/** Inserts a job; `id` is prefixed with `webtest:` unless it already is. Returns the full id. */
export async function insertJob(row: JobRow) {
  const id = row.id.startsWith(PREFIX) ? row.id : PREFIX + row.id;
  const data: Record<string, unknown> = {
    source: 'greenhouse', company: 'Acme', title: 'Engineer', country: 'AE', url: `https://example.com/${id}`,
    status: 'new', score: 50, ...row, id,
  };
  if (data.form_answers) data.form_answers = JSON.stringify(data.form_answers);
  const cols = Object.keys(data);
  await pool.query(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => data[c]));
  return id;
}

export async function insertFetchRun(input: { started_at?: Date; finished_at?: Date | null; checked?: number; inserted?: number;
  new_matches?: number; errors?: { company: string; error: string }[] }) {
  const run = { ...input, ...(input.errors && { errors: JSON.stringify(input.errors) }) };
  const cols = Object.keys(run);
  const { rows } = await pool.query<{ id: number }>(
    cols.length
      ? `INSERT INTO fetch_runs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`
      : 'INSERT INTO fetch_runs DEFAULT VALUES RETURNING id',
    cols.map((c) => (run as Record<string, unknown>)[c]));
  fetchRunIds.push(rows[0].id);
  return rows[0].id;
}

/** Removes only this suite's rows (job_events cascade from jobs). */
export async function cleanupDb() {
  await pool.query(`DELETE FROM jobs WHERE id LIKE '${PREFIX}%'`);
  if (fetchRunIds.length) await pool.query('DELETE FROM fetch_runs WHERE id = ANY($1)', [fetchRunIds.splice(0)]);
}

export async function closeDb() {
  await cleanupDb();
  await pool.end();
  delete (globalThis as { jobBotPool?: unknown }).jobBotPool;
}

/** Keeps only this suite's ids, in the order returned. */
export const ours = <T extends { id: string }>(rows: T[]) => rows.filter((r) => r.id.startsWith(PREFIX)).map((r) => r.id);

export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
