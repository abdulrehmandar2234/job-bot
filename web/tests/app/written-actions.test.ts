import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rewriteLetter, rewriteSummary, saveLetter, saveSummary, tailorCv, writeLetter, writeSummary } from '@/app/actions';
import { spawnBot } from '@/lib/bot';
import { getJob, pool } from '@/lib/db';
import type { Task } from '@/lib/tasks';
import { checkFeedback, checkText, FEEDBACK_CAP, TEXT_CAP } from '@/lib/written-text';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

// The cover letter and CV summary actions on the job page: queue the AI (with feedback), or save the user's own text.

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  spawnBot: vi.fn(),
}));

const spawn = vi.mocked(spawnBot);
const id = PREFIX + 'written';
const form = (fields: Record<string, string | Blob>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const tasks = async () => (await pool.query<Task>('SELECT * FROM tasks WHERE job_id = $1 ORDER BY id', [id])).rows;

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'prepared', cover_letter: 'Dear Acme,\nAI letter\n', cover_letter_ai: true });
  vi.clearAllMocks();
});
afterAll(closeDb);

describe('validation shared with the bot', () => {
  it('FEEDBACK_CAP matches src/tasks.ts, which checks the task args again', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src', 'tasks.ts'), 'utf8');
    expect(Number(src.match(/export const FEEDBACK_CAP = (\d+);/)![1])).toBe(FEEDBACK_CAP);
    expect(FEEDBACK_CAP).toBe(1000);
  });

  it('checkFeedback trims, and refuses empty, too long and non-text feedback', () => {
    expect(checkFeedback('  shorter  ')).toEqual({ feedback: 'shorter' });
    expect(checkFeedback('x'.repeat(FEEDBACK_CAP))).toEqual({ feedback: 'x'.repeat(FEEDBACK_CAP) });
    expect(checkFeedback('x'.repeat(FEEDBACK_CAP + 1))).toEqual({ error: 'Feedback is too long: at most 1000 characters.' });
    expect(checkFeedback('  ')).toEqual({ error: 'Write what should change first.' });
    for (const v of [null, 42, new Blob(['x'])]) expect(checkFeedback(v)).toEqual({ error: 'Feedback must be text.' });
  });

  it('checkText keeps letter paragraphs with \\n line ends and makes the summary one paragraph', () => {
    expect(checkText('letter', '  Dear Acme,\r\n\r\nBody\r\n')).toEqual({ text: 'Dear Acme,\n\nBody\n' });
    expect(checkText('summary', ' Senior engineer.\r\n Laravel  and Vue. ')).toEqual({ text: 'Senior engineer. Laravel and Vue.' });
    expect(checkText('summary', 'x'.repeat(TEXT_CAP.summary + 1))).toEqual({ error: 'The summary is too long: at most 2000 characters.' });
    expect(checkText('letter', ' \n ')).toEqual({ error: 'The letter is empty.' });
    expect(checkText('letter', null)).toEqual({ error: 'The letter must be text.' });
  });
});

describe.each([
  ['letter', rewriteLetter],
  ['summary', rewriteSummary],
] as const)('rewrite %s with feedback', (kind, action) => {
  it(`queues a ${kind} task with the trimmed feedback in its args and refreshes`, async () => {
    const state = await action(null, form({ id, feedback: '  shorter,\nless formal  ' }));
    expect(state).toEqual({ ok: true, message: 'Rewriting with your feedback…' });
    const [t] = await tasks();
    expect(t).toMatchObject({ kind, job_id: id, status: 'queued', args: { feedback: 'shorter,\nless formal' } });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(t.id)]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it.each([
    ['too long', 'x'.repeat(FEEDBACK_CAP + 1), 'Feedback is too long: at most 1000 characters.'],
    ['empty', '   ', 'Write what should change first.'],
    ['a file, not text', new Blob(['shorter']), 'Feedback must be text.'],
  ] as const)('answers with an error for %s feedback and queues nothing', async (_, feedback, message) => {
    expect(await action(null, form({ id, feedback }))).toEqual({ ok: false, message });
    expect(await action(null, form({ id }))).toEqual({ ok: false, message: 'Feedback must be text.' });
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rejects a missing or unknown job', async () => {
    await expect(action(null, form({ feedback: 'shorter' }))).rejects.toThrow('Missing job id');
    await expect(action(null, form({ id: PREFIX + 'nope', feedback: 'shorter' }))).rejects.toThrow('Unknown job');
    expect(await tasks()).toEqual([]);
  });
});

describe('saveLetter', () => {
  it('stores the edited letter with no AI: cover_letter_ai false and the edit time set', async () => {
    const state = await saveLetter(null, form({ id, text: 'Dear Acme,\r\n\r\nMy own words.\r\n' }));
    expect(state).toEqual({ ok: true, message: 'Saved.' });
    const job = (await getJob(id))!;
    expect(job.cover_letter).toBe('Dear Acme,\n\nMy own words.\n');
    expect(job.cover_letter_ai).toBe(false);
    expect(job.cover_letter_edited_at).toBeInstanceOf(Date);
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refuses an empty or too long letter and keeps the stored one', async () => {
    expect(await saveLetter(null, form({ id, text: '  ' }))).toEqual({ ok: false, message: 'The letter is empty.' });
    expect(await saveLetter(null, form({ id, text: 'x'.repeat(TEXT_CAP.letter + 1) }))).toEqual({
      ok: false,
      message: 'The letter is too long: at most 10000 characters.',
    });
    expect((await getJob(id))!.cover_letter).toBe('Dear Acme,\nAI letter\n');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses while the bot is rewriting the letter, which would overwrite the edit', async () => {
    await writeLetter(form({ id }));
    expect(await saveLetter(null, form({ id, text: 'Mine' }))).toEqual({
      ok: false,
      message: 'The letter is being rewritten right now. Save again when it is done.',
    });
    expect((await getJob(id))!.cover_letter).toBe('Dear Acme,\nAI letter\n');
  });

  it('rejects an unknown job', async () => {
    await expect(saveLetter(null, form({ id: PREFIX + 'nope', text: 'x' }))).rejects.toThrow('Unknown job');
  });
});

describe('CV summary', () => {
  it('writeSummary queues a summary task without feedback', async () => {
    await writeSummary(form({ id }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'summary', job_id: id, args: {} });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(t.id)]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('tailorCv queues a tailored_cv task once a summary exists, and refuses before', async () => {
    await expect(tailorCv(form({ id }))).rejects.toThrow('Write the CV summary for this job first');
    expect(await tasks()).toEqual([]);
    await pool.query(`UPDATE jobs SET cv_summary = 'Senior engineer.' WHERE id = $1`, [id]);
    await tailorCv(form({ id }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'tailored_cv', job_id: id, args: {} });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(t.id)]);
    await expect(tailorCv(form({ id: PREFIX + 'nope' }))).rejects.toThrow('Unknown job');
  });

  it('tailorCv reads the job and its summary in one query: a job that disappears is "Unknown job", not a crash', async () => {
    const gone = PREFIX + 'tailor-gone';
    await insertJob({ id: gone, cv_summary: 'Senior engineer.' });
    await pool.query('DELETE FROM jobs WHERE id = $1', [gone]);
    await expect(tailorCv(form({ id: gone }))).rejects.toThrow('Unknown job');
    await expect(tailorCv(form({}))).rejects.toThrow('Missing job id');
  });

  it('saveSummary stores the edited summary as one paragraph and marks it edited', async () => {
    await pool.query(`UPDATE jobs SET cv_summary = 'AI summary.', cv_summary_at = now() - interval '1 day' WHERE id = $1`, [id]);
    expect(await saveSummary(null, form({ id, text: ' My own\r\nsummary. ' }))).toEqual({ ok: true, message: 'Saved.' });
    const job = (await getJob(id))!;
    expect(job.cv_summary).toBe('My own summary.');
    expect(job.cv_summary_edited_at).toBeInstanceOf(Date);
    expect(Date.now() - job.cv_summary_at!.getTime()).toBeLessThan(60_000);
    expect(job.cover_letter_ai).toBe(true); // the letter is untouched
  });

  it('saveSummary refuses while a summary task runs', async () => {
    await writeSummary(form({ id }));
    expect((await saveSummary(null, form({ id, text: 'Mine' })))?.ok).toBe(false);
    expect((await getJob(id))!.cv_summary).toBeNull();
  });
});
