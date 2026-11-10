'use server';

import { refresh } from 'next/cache';
import { ActionError, botFailure, guarded } from '@/lib/action-state';
import { runBot } from '@/lib/bot';
import { assertJob } from '@/lib/job-lock';
import { enqueueTask } from '@/lib/tasks';
import type { TextFormState } from '@/lib/written-text';

// Follow-up reminders on the job page. Server actions are reachable by POST, so the id is validated here.
// The bot only drafts the message; the user sends it. Expected failures come back as a TextFormState for the
// button's form (components/action-form.tsx) instead of crashing the page into app/error.tsx.

/** Drafts a follow-up message: queues `bot follow-up <id>` as a background task and returns at once. */
export async function draftFollowUp(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    await enqueueTask('follow_up', await assertJob(formData.get('id')));
    refresh();
  });
}

/** Records that the user sent a follow-up (`bot followed-up <id>`), so the reminder waits again. */
export async function markFollowedUp(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    try {
      await runBot(['followed-up', id], 30_000);
    } catch (e) {
      throw new ActionError(botFailure(e));
    }
    refresh();
  });
}
