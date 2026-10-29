'use server';

import { refresh } from 'next/cache';
import { pool, STATUSES, type Status } from '@/lib/db';
import { dismissTask as dismissFailedTask, enqueueTask } from '@/lib/tasks';
import { skipReason } from '@/lib/skips';

// Server actions are reachable by POST, so every input is validated here.
const USER_STATUSES: readonly Status[] = STATUSES.filter((s) => s !== 'filtered');

async function assertJob(id: unknown): Promise<string> {
  if (typeof id !== 'string' || !id) throw new Error('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Unknown job');
  return id;
}

export async function setStatus(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  const status = formData.get('status') as Status;
  if (!USER_STATUSES.includes(status)) throw new Error('Invalid status');
  const note = (formData.get('note') as string | null)?.trim() || null;
  const reason = status === 'skipped' ? skipReason(formData.get('reason')) : null; // optional, see SkipButton

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [id]);
    await client.query(
      `UPDATE jobs SET status = $2, applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END WHERE id = $1`,
      [id, status]);
    await client.query('INSERT INTO job_events (job_id, from_status, to_status, note, reason) VALUES ($1, $2, $3, $4, $5)',
      [id, rows[0].status, status, note, reason]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  refresh();
}

export async function saveNotes(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  const notes = String(formData.get('notes') ?? '').slice(0, 5000);
  await pool.query('UPDATE jobs SET notes = $2 WHERE id = $1', [id, notes || null]);
  refresh();
}

// Long bot commands run as background tasks (lib/tasks.ts): these actions queue one and return at once.
// The page shows the task while it runs and refreshes when it finishes (TaskWatcher).

/**
 * Default CV + cover letter (same as `npm run bot -- prepare <id>`). `force=true` ("Prepare anyway" on an expired
 * job) skips the check that the posting is still open (`prepare --force`).
 */
export async function prepare(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  const cv = formData.get('cv');
  const args: Record<string, string> = typeof cv === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(cv) ? { cv } : {};
  if (formData.get('force') === 'true') args.force = 'true';
  await enqueueTask('prepare', id, args);
  refresh();
}

/** AI fit review of one job via the local Claude CLI (`bot ai:score --id`). */
export async function aiReview(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  await enqueueTask('ai_review', id);
  refresh();
}

/**
 * AI drafts answers to questions pasted from an application form (`bot answer`). Nothing is submitted anywhere.
 * The questions travel in the task's args; the worker writes them to a temp file for `answer --file`.
 */
export async function draftAnswers(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  const questions = String(formData.get('questions') ?? '').trim().slice(0, 8000);
  if (!questions) return;
  await enqueueTask('answers', id, { questions });
  refresh();
}

export async function clearAnswers(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  await pool.query(`UPDATE jobs SET form_answers = '[]' WHERE id = $1`, [id]);
  refresh();
}

/** Pulls fresh postings from every source in the background; LinkedIn is paced slowly, so a full run takes ~10 minutes. */
export async function fetchNow() {
  await enqueueTask('fetch', null);
  refresh();
}

/** Hides a failed task's error from the dashboard. */
export async function dismissTask(formData: FormData) {
  const id = Number(formData.get('task'));
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid task');
  await dismissFailedTask(id);
  refresh();
}
