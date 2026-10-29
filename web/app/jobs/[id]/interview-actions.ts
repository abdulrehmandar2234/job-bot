'use server';

import { refresh } from 'next/cache';
import { pool } from '@/lib/db';
import { runBot } from '@/lib/bot';

// Interview prep for the job page. Server actions are reachable by POST, so the id is validated here.

/** Runs `bot prep <id>`. Kept in one place so it can move to the task queue later. */
export async function runPrep(id: string) {
  await runBot(['prep', id], 240_000);
}

/** AI interview prep (questions, STAR stories, company brief, requirement map) for one job. */
export async function prepareInterview(formData: FormData) {
  const id = formData.get('id');
  if (typeof id !== 'string' || !id) throw new Error('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Unknown job');
  await runPrep(id);
  refresh();
}
