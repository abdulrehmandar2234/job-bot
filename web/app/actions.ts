'use server';

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { pool, STATUSES, type Status } from '@/lib/db';
import { BOT_ROOT, runBot } from '@/lib/bot';

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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [id]);
    await client.query(
      `UPDATE jobs SET status = $2, applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END WHERE id = $1`,
      [id, status]);
    await client.query('INSERT INTO job_events (job_id, from_status, to_status, note) VALUES ($1, $2, $3, $4)',
      [id, rows[0].status, status, note]);
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

/** Default CV + cover letter (same as `npm run bot -- prepare <id>`). */
export async function prepare(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  const cv = formData.get('cv');
  const args = ['prepare', id];
  if (typeof cv === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(cv)) args.push('--cv', cv);
  await runBot(args, 240_000);
  refresh();
}

/** AI fit review of one job via the local Claude CLI (`bot ai:score --id`). */
export async function aiReview(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  await runBot(['ai:score', '--id', id], 240_000);
  refresh();
}

/** AI drafts answers to questions pasted from an application form (`bot answer`). Nothing is submitted anywhere. */
export async function draftAnswers(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  const questions = String(formData.get('questions') ?? '').trim().slice(0, 8000);
  if (!questions) return;
  const dir = join(BOT_ROOT, 'data', 'questions');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.txt`);
  await writeFile(file, questions);
  try {
    await runBot(['answer', id, '--file', file], 240_000);
  } finally {
    await rm(file, { force: true });
  }
  refresh();
}

export async function clearAnswers(formData: FormData) {
  const id = await assertJob(formData.get('id'));
  await pool.query(`UPDATE jobs SET form_answers = '[]' WHERE id = $1`, [id]);
  refresh();
}

/** Pulls fresh postings from every source; LinkedIn is paced slowly, so a full run takes ~10 minutes. */
export async function fetchNow() {
  await runBot(['fetch'], 20 * 60_000);
  refresh();
}
