'use server';

import { refresh } from 'next/cache';
import { runBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import { enqueueTask } from '@/lib/tasks';

// Follow-up reminders on the job page. Server actions are reachable by POST, so the id is validated here.
// The bot only drafts the message; the user sends it.

async function jobId(formData: FormData) {
  const id = formData.get('id');
  if (typeof id !== 'string' || !id) throw new Error('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Unknown job');
  return id;
}

/** Drafts a follow-up message: queues `bot follow-up <id>` as a background task and returns at once. */
export async function draftFollowUp(formData: FormData) {
  await enqueueTask('follow_up', await jobId(formData));
  refresh();
}

/** Records that the user sent a follow-up (`bot followed-up <id>`), so the reminder waits again. */
export async function markFollowedUp(formData: FormData) {
  await runBot(['followed-up', await jobId(formData)], 30_000);
  refresh();
}
