'use server';

import { refresh } from 'next/cache';
import { ActionError, guarded } from '@/lib/action-state';
import { pool } from '@/lib/db';
import { enqueueTask } from '@/lib/tasks';
import type { TextFormState } from '@/lib/written-text';

// Interview prep for the job page. Server actions are reachable by POST, so the id is validated here.
// Expected failures come back as a TextFormState for the button's form instead of crashing the page.

/**
 * AI interview prep (questions, STAR stories, company brief, requirement map) for one job: queues `bot prep <id>`
 * as a background task and returns at once. The page shows it while it runs and refreshes when it finishes.
 */
export async function prepareInterview(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = formData.get('id');
    if (typeof id !== 'string' || !id) throw new ActionError('Missing job id');
    const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
    if (!rowCount) throw new ActionError('Unknown job');
    await enqueueTask('prep', id);
    refresh();
  });
}
