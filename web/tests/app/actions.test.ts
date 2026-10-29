import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiReview, clearAnswers, dismissTask, draftAnswers, fetchNow, prepare, saveNotes, setStatus } from '@/app/actions';
import { spawnBot } from '@/lib/bot';
import { getJob, jobEvents, pool } from '@/lib/db';
import type { Task } from '@/lib/tasks';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module, but never start a bot worker process.
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  spawnBot: vi.fn(),
}));

const spawn = vi.mocked(spawnBot);
const id = PREFIX + 'act';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
/** Tasks for our job, plus job-less ones (fetch), oldest first. */
const tasks = async () => (await pool.query<Task>(
  `SELECT * FROM tasks WHERE job_id = $1 OR job_id IS NULL ORDER BY id`, [id])).rows;
/** The worker each started task gets: `task:run <id>`. */
const spawnedFor = (t: Task) => ['task:run', String(t.id)];

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'new' });
  vi.clearAllMocks();
});
afterAll(closeDb);

describe('job id validation (shared by every action)', () => {
  it.each([
    ['setStatus', setStatus], ['saveNotes', saveNotes], ['prepare', prepare], ['aiReview', aiReview],
    ['draftAnswers', draftAnswers], ['clearAnswers', clearAnswers],
  ] as const)('%s rejects a missing or unknown job', async (_, action) => {
    await expect(action(form({ status: 'applied', questions: 'Q?' }))).rejects.toThrow('Missing job id');
    await expect(action(form({ id: PREFIX + 'nope', status: 'applied', questions: 'Q?' }))).rejects.toThrow('Unknown job');
    expect(spawn).not.toHaveBeenCalled();
    expect(await tasks()).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('setStatus', () => {
  it('moves the job, logs the change with a trimmed note and refreshes', async () => {
    await setStatus(form({ id, status: 'skipped', note: '  too junior  ' }));
    const job = await getJob(id);
    expect(job!.status).toBe('skipped');
    expect(job!.applied_at).toBeNull();
    const events = await jobEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from_status: 'new', to_status: 'skipped', note: 'too junior' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('stores the optional skip reason in the same history row, and ignores it for other moves', async () => {
    await setStatus(form({ id, status: 'skipped', reason: 'seniority' }));
    expect((await jobEvents(id))[0]).toMatchObject({ to_status: 'skipped', reason: 'seniority' });
    await setStatus(form({ id, status: 'new', reason: 'stack' }));
    await setStatus(form({ id, status: 'skipped', reason: 'boredom' }));
    expect((await jobEvents(id)).map((e) => e.reason)).toEqual([null, null, 'seniority']);
  });

  it('stamps applied_at when marked applied, and stores an empty note as null', async () => {
    await setStatus(form({ id, status: 'applied', note: '   ' }));
    const job = await getJob(id);
    expect(job!.status).toBe('applied');
    expect(Date.now() - job!.applied_at!.getTime()).toBeLessThan(60_000);
    expect((await jobEvents(id))[0].note).toBeNull();
  });

  it('keeps applied_at on later moves', async () => {
    await setStatus(form({ id, status: 'applied' }));
    const appliedAt = (await getJob(id))!.applied_at;
    await setStatus(form({ id, status: 'interview' }));
    expect((await getJob(id))!.applied_at).toEqual(appliedAt);
    expect((await jobEvents(id)).map((e) => `${e.from_status}->${e.to_status}`)).toEqual(['applied->interview', 'new->applied']);
  });

  it.each(['filtered', 'bogus', ''])('rejects status %j without changing anything', async (status) => {
    await expect(setStatus(form({ id, status }))).rejects.toThrow('Invalid status');
    expect((await getJob(id))!.status).toBe('new');
    expect(await jobEvents(id)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('saveNotes', () => {
  it('saves notes, capped at 5000 characters', async () => {
    await saveNotes(form({ id, notes: 'x'.repeat(6000) }));
    expect((await getJob(id))!.notes).toHaveLength(5000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('clears notes when empty', async () => {
    await saveNotes(form({ id, notes: 'Recruiter: Sam' }));
    expect((await getJob(id))!.notes).toBe('Recruiter: Sam');
    await saveNotes(form({ id, notes: '' }));
    expect((await getJob(id))!.notes).toBeNull();
  });
});

describe('prepare', () => {
  it('queues a prepare task, starts its worker and refreshes at once', async () => {
    await prepare(form({ id }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'prepare', job_id: id, args: {}, status: 'queued' });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('passes a valid CV version', async () => {
    await prepare(form({ id, cv: 'backend-lead-2' }));
    expect((await tasks())[0].args).toEqual({ cv: 'backend-lead-2' });
  });

  it.each(['../../etc', 'Backend', 'a b', 'x;rm', '', '--help', '-x'])('ignores an invalid CV version %j', async (cv) => {
    await prepare(form({ id, cv }));
    expect((await tasks())[0].args).toEqual({});
  });

  it('returns the running task on a second click instead of starting another', async () => {
    await prepare(form({ id }));
    await pool.query(`UPDATE tasks SET status = 'running' WHERE job_id = $1`, [id]);
    await prepare(form({ id }));
    expect(await tasks()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('starts again after the previous task finished', async () => {
    await prepare(form({ id }));
    await pool.query(`UPDATE tasks SET status = 'done' WHERE job_id = $1`, [id]);
    await prepare(form({ id }));
    expect((await tasks()).map((t) => t.status)).toEqual(['done', 'queued']);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('aiReview', () => {
  it('queues an ai_review task and refreshes', async () => {
    await aiReview(form({ id }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'ai_review', job_id: id, status: 'queued' });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('runs alongside a prepare task for the same job', async () => {
    await prepare(form({ id }));
    await aiReview(form({ id }));
    expect((await tasks()).map((t) => t.kind)).toEqual(['prepare', 'ai_review']);
  });
});

describe('draftAnswers', () => {
  it('queues an answers task with the trimmed questions in its args', async () => {
    await draftAnswers(form({ id, questions: '  Why us?\nVisa needed?  ' }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'answers', job_id: id, args: { questions: 'Why us?\nVisa needed?' } });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('caps the questions at 8000 characters', async () => {
    await draftAnswers(form({ id, questions: 'q'.repeat(9000) }));
    expect((await tasks())[0].args.questions).toHaveLength(8000);
  });

  it.each(['', '   \n  '])('does nothing for empty questions %j', async (questions) => {
    await draftAnswers(form({ id, questions }));
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when the questions field is absent', async () => {
    await draftAnswers(form({ id }));
    expect(await tasks()).toEqual([]);
  });
});

describe('clearAnswers', () => {
  it('empties the drafted answers', async () => {
    await insertJob({ id: 'with-answers', form_answers: [{ question: 'Q', answer: 'A', needs_input: false, note: '' }] });
    await clearAnswers(form({ id: PREFIX + 'with-answers' }));
    expect((await getJob(PREFIX + 'with-answers'))!.form_answers).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('fetchNow', () => {
  it('queues one fetch task and returns at once', async () => {
    await fetchNow();
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'fetch', job_id: null, status: 'queued' });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('never runs two fetches at a time', async () => {
    await fetchNow();
    await fetchNow();
    expect(await tasks()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('a fetch whose worker died does not block a new one', async () => {
    await fetchNow();
    await pool.query(`UPDATE tasks SET status = 'running', deadline = now() - interval '1 second' WHERE job_id IS NULL`);
    await fetchNow();
    const [dead, fresh] = await tasks();
    expect(dead).toMatchObject({ status: 'failed', error: expect.stringMatching(/Timed out/) });
    expect(fresh.status).toBe('queued');
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('dismissTask', () => {
  it('hides a failed task', async () => {
    await prepare(form({ id }));
    const [t] = await tasks();
    await pool.query(`UPDATE tasks SET status = 'failed', error = 'boom' WHERE id = $1`, [t.id]);
    await dismissTask(form({ task: String(t.id) }));
    expect((await tasks())[0].dismissed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not touch a running task', async () => {
    await prepare(form({ id }));
    await dismissTask(form({ task: String((await tasks())[0].id) }));
    expect((await tasks())[0]).toMatchObject({ status: 'queued', dismissed: false });
  });

  it.each(['', 'abc', '-1', '1.5', '0'])('rejects task id %j', async (task) => {
    await expect(dismissTask(form({ task }))).rejects.toThrow('Invalid task');
  });
});
