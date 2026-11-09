'use server';

import { refresh } from 'next/cache';
import { ActionError, guarded } from '@/lib/action-state';
import { PAGE_SIZES, pool, STATUSES, type Status } from '@/lib/db';
import { CvBusyError, dismissTask as dismissFailedTask, enqueueTask, type TaskKind } from '@/lib/tasks';
import { checkFeedback, checkText, type TextFormState, type WrittenKind } from '@/lib/written-text';
import { skipReason } from '@/lib/skips';
import { CV_VERSION, isTemplate } from '@/lib/cv-templates';

// Server actions are reachable by POST, so every input is validated here.
// Expected failures (unknown job, DB hiccup, a busy CV) come back as a TextFormState for the button's form
// (components/action-form.tsx) instead of throwing, which would replace the page with app/error.tsx.
const USER_STATUSES: readonly Status[] = STATUSES.filter((s) => s !== 'filtered');

async function assertJob(id: unknown): Promise<string> {
  if (typeof id !== 'string' || !id) throw new ActionError('Missing job id');
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new ActionError('Unknown job');
  return id;
}

export async function setStatus(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const status = formData.get('status') as Status;
    if (!USER_STATUSES.includes(status)) throw new ActionError('Invalid status');
    const note = (formData.get('note') as string | null)?.trim() || null;
    const reason = status === 'skipped' ? skipReason(formData.get('reason')) : null; // optional, see SkipButton

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1 FOR UPDATE', [id]);
      await client.query(
        `UPDATE jobs SET status = $2, applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END WHERE id = $1`,
        [id, status],
      );
      await client.query('INSERT INTO job_events (job_id, from_status, to_status, note, reason) VALUES ($1, $2, $3, $4, $5)', [
        id,
        rows[0].status,
        status,
        note,
        reason,
      ]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    refresh();
  });
}

// At most a page of jobs can be selected at once (the triage layer selects from the rendered cards).
const BULK_CAP = Math.max(...PAGE_SIZES);

/**
 * Skips every selected job in one transaction, with one optional reason for them all (the bulk-skip bar,
 * components/triage.tsx). Ids that vanished mid-click (dedupe) are ignored; the answer says how many were skipped.
 */
export async function skipSelected(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const ids = [...new Set(formData.getAll('id').filter((v): v is string => typeof v === 'string' && v !== ''))];
    if (!ids.length) throw new ActionError('No jobs selected');
    if (ids.length > BULK_CAP) throw new ActionError(`At most ${BULK_CAP} jobs can be skipped at once`);
    const reason = skipReason(formData.get('reason'));

    const client = await pool.connect();
    let skipped = 0;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM jobs WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [ids],
      );
      if (!rows.length) throw new ActionError('Unknown jobs');
      await client.query(`UPDATE jobs SET status = 'skipped' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
      await client.query(
        `INSERT INTO job_events (job_id, from_status, to_status, reason)
         SELECT unnest($1::text[]), unnest($2::text[]), 'skipped', $3`,
        [rows.map((r) => r.id), rows.map((r) => r.status), reason],
      );
      await client.query('COMMIT');
      skipped = rows.length;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    refresh();
    return { ok: true, message: `Skipped ${skipped} job${skipped === 1 ? '' : 's'}` };
  });
}

export async function saveNotes(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const notes = String(formData.get('notes') ?? '').slice(0, 5000);
    await pool.query('UPDATE jobs SET notes = $2 WHERE id = $1', [id, notes || null]);
    refresh();
  });
}

// Long bot commands run as background tasks (lib/tasks.ts): these actions queue one and return at once.
// The page shows the task while it runs and refreshes when it finishes (TaskWatcher).

/**
 * Picks or builds the CV (same as `npm run bot -- prepare <id>`); the cover letter is written only with writeLetter. `force=true` ("Prepare anyway" on an expired
 * job) skips the check that the posting is still open (`prepare --force`).
 */
export async function prepare(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const cv = formData.get('cv');
    const args: Record<string, string> = typeof cv === 'string' && CV_VERSION.test(cv) ? { cv } : {};
    if (formData.get('force') === 'true') args.force = 'true';
    const busy = await enqueueCvChange('prepare', id, args);
    if (busy) return busy;
    refresh();
  });
}

/** Writes or rewrites the cover letter (`bot letter <id>`), only when the user asks for it. */
export async function writeLetter(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    await enqueueTask('letter', id);
    refresh();
  });
}

/** Writes or rewrites the CV summary for this job (`bot summary <id>`). */
export async function writeSummary(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    await enqueueTask('summary', id);
    refresh();
  });
}

/** Writes or rewrites the CV headline for this job (`bot headline <id>`). */
export async function writeHeadline(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    await enqueueTask('headline', id);
    refresh();
  });
}

/** Builds a one-off CV with the job's CV headline and summary and makes it the job's CV (`bot cv:tailor <id>`). */
export async function tailorCv(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = formData.get('id');
    if (typeof id !== 'string' || !id) throw new ActionError('Missing job id');
    // One query for the job and its texts, so a job deleted after a separate existence check cannot crash this.
    const { rows } = await pool.query<{ cv_summary: string | null; cv_headline: string | null }>(
      'SELECT cv_summary, cv_headline FROM jobs WHERE id = $1',
      [id],
    );
    if (!rows.length) throw new ActionError('Unknown job');
    if (!rows[0].cv_summary && !rows[0].cv_headline) throw new ActionError('Write the CV headline or summary for this job first');
    const busy = await enqueueCvChange('tailored_cv', id);
    if (busy) return busy;
    refresh();
  });
}

const TASK_FOR: Record<WrittenKind, TaskKind> = { letter: 'letter', summary: 'summary', headline: 'headline' };

/** Queues the AI rewrite of the letter, summary or headline with the user's feedback (`bot <kind> <id> --feedback`). */
async function rewrite(kind: WrittenKind, formData: FormData): Promise<TextFormState> {
  const id = await assertJob(formData.get('id'));
  const checked = checkFeedback(formData.get('feedback'));
  if ('error' in checked) return { ok: false, message: checked.error };
  await enqueueTask(TASK_FOR[kind], id, { feedback: checked.feedback });
  refresh();
  return { ok: true, message: 'Rewriting with your feedback…' };
}

export async function rewriteLetter(_prev: TextFormState, formData: FormData) {
  return guarded(() => rewrite('letter', formData));
}

export async function rewriteSummary(_prev: TextFormState, formData: FormData) {
  return guarded(() => rewrite('summary', formData));
}

export async function rewriteHeadline(_prev: TextFormState, formData: FormData) {
  return guarded(() => rewrite('headline', formData));
}

const SAVE_SQL: Record<WrittenKind, string> = {
  letter: 'UPDATE jobs SET cover_letter = $2, cover_letter_ai = false, cover_letter_edited_at = now() WHERE id = $1',
  summary: 'UPDATE jobs SET cv_summary = $2, cv_summary_at = now(), cv_summary_edited_at = now() WHERE id = $1',
  headline: 'UPDATE jobs SET cv_headline = $2, cv_headline_at = now(), cv_headline_edited_at = now() WHERE id = $1',
};

/** Stores the text the user edited by hand, with no AI. Refused while the bot is rewriting it (it would overwrite). */
async function saveText(kind: WrittenKind, formData: FormData): Promise<TextFormState> {
  const id = await assertJob(formData.get('id'));
  const checked = checkText(kind, formData.get('text'));
  if ('error' in checked) return { ok: false, message: checked.error };
  const { rowCount } = await pool.query(`SELECT 1 FROM tasks WHERE job_id = $1 AND kind = $2 AND status IN ('queued', 'running')`, [
    id,
    TASK_FOR[kind],
  ]);
  if (rowCount) return { ok: false, message: `The ${kind} is being rewritten right now. Save again when it is done.` };
  await pool.query(SAVE_SQL[kind], [id, checked.text]);
  refresh();
  return { ok: true, message: 'Saved.' };
}

export async function saveLetter(_prev: TextFormState, formData: FormData) {
  return guarded(() => saveText('letter', formData));
}

export async function saveSummary(_prev: TextFormState, formData: FormData) {
  return guarded(() => saveText('summary', formData));
}

export async function saveHeadline(_prev: TextFormState, formData: FormData) {
  return guarded(() => saveText('headline', formData));
}

/**
 * Queues a CV-changing task (CV_CHANGES in lib/tasks.ts: one at a time per job, checked by the insert itself).
 * Returns the refusal when another task is already changing the job's CV, so no click is lost silently.
 */
async function enqueueCvChange(kind: TaskKind, id: string, args: Record<string, string> = {}): Promise<TextFormState> {
  try {
    await enqueueTask(kind, id, args);
    return null;
  } catch (e) {
    if (e instanceof CvBusyError) return { ok: false, message: e.message };
    throw e;
  }
}

/**
 * Uses a CV template for this job and re-renders its CV in it as a new version (`bot cv:template <id> <template>`).
 * While the job's CV is being changed by another task, answers with the refusal instead of queueing.
 */
export async function applyCvTemplate(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const template = formData.get('template');
    if (!isTemplate(template)) throw new ActionError('Unknown CV template');
    const busy = await enqueueCvChange('cv_template', id, { template });
    if (busy) return busy;
    refresh();
    return { ok: true, message: 'Applying the template…' };
  });
}

/** Queues the AI revision of the job's CV with the user's feedback (`bot cv:feedback <id> --feedback`). */
export async function improveCv(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const checked = checkFeedback(formData.get('feedback'));
    if ('error' in checked) return { ok: false, message: checked.error };
    const busy = await enqueueCvChange('cv_feedback', id, { feedback: checked.feedback });
    if (busy) return busy;
    refresh();
    return { ok: true, message: 'Improving your CV with your feedback…' };
  });
}

/** A skill name as the bot's job keyword list writes them (src/match.ts SKILLS); the bot checks the names again. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9 .#/+-]{0,29}$/;

/**
 * "I have this" on the CV keyword check: adds the ticked job skills to the master CV, then the AI improves the job's
 * CV with them and the optional note (`bot cv:feedback <id> --add-skills … [--feedback …]`).
 */
export async function addSkillsToCv(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const skills = formData.getAll('skill');
    if (!skills.length) return { ok: false, message: 'Tick the skills you have first.' };
    if (skills.length > 50 || skills.some((s) => typeof s !== 'string' || !SKILL_NAME.test(s)))
      return { ok: false, message: 'Unknown skill name.' };
    const note = formData.get('feedback');
    let feedback = '';
    if (typeof note === 'string' && note.trim()) {
      const checked = checkFeedback(note);
      if ('error' in checked) return { ok: false, message: checked.error };
      feedback = checked.feedback;
    }
    const busy = await enqueueCvChange('cv_feedback', id, { skills: skills.join(','), ...(feedback ? { feedback } : {}) });
    if (busy) return busy;
    refresh();
    return { ok: true, message: 'Adding the skills to your master CV and improving this CV…' };
  });
}

/** The AI's short review of the job's CV against the job (`bot cv:review <id>`), stored on the job. */
export async function reviewCv(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    await enqueueTask('cv_review', id);
    refresh();
  });
}

/** AI fit review of one job via the configured AI provider (`bot ai:score --id`). */
export async function aiReview(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    await enqueueTask('ai_review', id);
    refresh();
  });
}

/**
 * AI drafts answers to questions pasted from an application form (`bot answer`). Nothing is submitted anywhere.
 * The questions travel in the task's args; the worker writes them to a temp file for `answer --file`.
 */
export async function draftAnswers(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    const questions = String(formData.get('questions') ?? '')
      .trim()
      .slice(0, 8000);
    if (!questions) return;
    await enqueueTask('answers', id, { questions });
    refresh();
  });
}

export async function clearAnswers(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = await assertJob(formData.get('id'));
    await pool.query(`UPDATE jobs SET form_answers = '[]' WHERE id = $1`, [id]);
    refresh();
  });
}

/** Pulls fresh postings from every source in the background; LinkedIn is paced slowly, so a full run takes ~10 minutes. */
export async function fetchNow(_prev?: TextFormState, _formData?: FormData): Promise<TextFormState> {
  return guarded(async () => {
    await enqueueTask('fetch', null);
    refresh();
  });
}

/** Hides a failed task's error from the dashboard. */
export async function dismissTask(_prev: TextFormState, formData: FormData): Promise<TextFormState> {
  return guarded(async () => {
    const id = Number(formData.get('task'));
    if (!Number.isInteger(id) || id <= 0) throw new ActionError('Invalid task');
    await dismissFailedTask(id);
    refresh();
  });
}
