'use server';

import { refresh } from 'next/cache';
import { ActionError, botFailure, guarded } from '@/lib/action-state';
import { assertJob } from '@/lib/job-lock';
import { runBot } from '@/lib/bot';
import type { TextFormState } from '@/lib/written-text';

// Dead-link check for the job page. Server actions are reachable by POST, so the id is validated here.
// Expected failures come back as a TextFormState for the button's form instead of crashing the page.

/** Runs `bot check:open <id>`: a closed posting moves to `expired` (jobs you applied to keep their status). */
export async function checkStillOpen(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    try {
      await runBot(['check:open', id], 60_000);
    } catch (e) {
      throw new ActionError(botFailure(e));
    }
    refresh();
  });
}
