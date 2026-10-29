'use server';

import { refresh } from 'next/cache';
import { pool } from '@/lib/db';
import { runBot } from '@/lib/bot';

// Dead-link check for the job page. Server actions are reachable by POST, so the id is validated here.

/** Runs `bot check:open <id>`: a closed posting moves to `expired` (jobs you applied to keep their status). */
export async function checkStillOpen(formData: FormData) {
  const id = formData.get('id');
  if (typeof id !== 'string' || !id) throw new Error('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Unknown job');
  await runBot(['check:open', id], 60_000);
  refresh();
}
