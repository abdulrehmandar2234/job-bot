'use server';

import { refresh } from 'next/cache';
import { pool } from '@/lib/db';
import { enqueueTask } from '@/lib/tasks';

// Interview prep for the job page. Server actions are reachable by POST, so the id is validated here.

/**
 * AI interview prep (questions, STAR stories, company brief, requirement map) for one job: queues `bot prep <id>`
 * as a background task and returns at once. The page shows it while it runs and refreshes when it finishes.
 */
export async function prepareInterview(formData: FormData) {
  const id = formData.get('id');
  if (typeof id !== 'string' || !id) throw new Error('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new Error('Unknown job');
  await enqueueTask('prep', id);
  refresh();
}
