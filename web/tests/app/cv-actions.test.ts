import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCvTemplate, improveCv, reviewCv } from '@/app/actions';
import { spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import type { Task } from '@/lib/tasks';
import { FEEDBACK_CAP } from '@/lib/written-text';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

// The job page's CV panel: Apply template, Improve CV with feedback and Suggest improvements queue background tasks.

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  spawnBot: vi.fn(),
}));

const spawn = vi.mocked(spawnBot);
const id = PREFIX + 'cv-panel';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const tasks = async () => (await pool.query<Task>('SELECT * FROM tasks WHERE job_id = $1 ORDER BY id', [id])).rows;

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'prepared', cv_version: 'default' });
  vi.clearAllMocks();
});
afterAll(closeDb);

describe('applyCvTemplate', () => {
  it('queues `cv:template` with the chosen template and starts its worker', async () => {
    await applyCvTemplate(form({ id, template: 'compact' }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'cv_template', status: 'queued', args: { template: 'compact' } });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(t.id)]);
    expect(refresh).toHaveBeenCalled();
  });

  it('refuses a template that is not in the list, and an unknown job', async () => {
    for (const template of ['fancy', '', 'Modern'])
      await expect(applyCvTemplate(form({ id, template }))).rejects.toThrow('Unknown CV template');
    await expect(applyCvTemplate(form({ id: PREFIX + 'nope', template: 'modern' }))).rejects.toThrow('Unknown job');
    expect(await tasks()).toEqual([]);
  });

  it('queues nothing while another task changes the CV', async () => {
    await pool.query(`INSERT INTO tasks (kind, job_id) VALUES ('cv_feedback', $1)`, [id]);
    await applyCvTemplate(form({ id, template: 'modern' }));
    expect((await tasks()).map((t) => t.kind)).toEqual(['cv_feedback']);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('improveCv', () => {
  it('queues `cv:feedback` with the trimmed feedback', async () => {
    expect(await improveCv(null, form({ id, feedback: '  put Laravel experience first\n' }))).toEqual({
      ok: true,
      message: 'Improving your CV with your feedback…',
    });
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'cv_feedback', args: { feedback: 'put Laravel experience first' } });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(t.id)]);
  });

  it('answers with the problem for empty or too long feedback, and while the CV is being changed', async () => {
    expect(await improveCv(null, form({ id, feedback: '  ' }))).toEqual({ ok: false, message: 'Write what should change first.' });
    expect(await improveCv(null, form({ id, feedback: 'x'.repeat(FEEDBACK_CAP + 1) }))).toEqual({
      ok: false,
      message: 'Feedback is too long: at most 1000 characters.',
    });
    await pool.query(`INSERT INTO tasks (kind, job_id) VALUES ('cv_template', $1)`, [id]);
    expect(await improveCv(null, form({ id, feedback: 'shorter' }))).toEqual({
      ok: false,
      message: 'The CV is being changed right now. Try again when it is done.',
    });
    expect((await tasks()).map((t) => t.kind)).toEqual(['cv_template']);
  });
});

describe('reviewCv', () => {
  it('queues `cv:review`, once while it runs', async () => {
    await reviewCv(form({ id }));
    await reviewCv(form({ id }));
    const all = await tasks();
    expect(all.map((t) => [t.kind, t.status])).toEqual([['cv_review', 'queued']]);
    expect(spawn).toHaveBeenCalledOnce();
  });
});
