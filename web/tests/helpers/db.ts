import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '@/lib/db';
import type { Job } from '../../../src/types';

// job_bot_test is shared with the bot's own tests: only touch rows with this id prefix, and fetch_runs we inserted.
export const PREFIX = 'webtest:';
const fetchRunIds: number[] = [];

// job-bot/src/schema.sql (a path string: jsdom replaces the global URL class).
const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'schema.sql'), 'utf8');

/** Applies the bot's (idempotent) schema; retried because another test run may be applying it at the same time. */
export async function ensureSchema() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
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

export async function insertFetchRun(run: { started_at?: Date; finished_at?: Date | null; checked?: number; inserted?: number; new_matches?: number }) {
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
