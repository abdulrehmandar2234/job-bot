import { refresh } from 'next/cache';
import { DatabaseError, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiReview, clearAnswers, dismissTask, draftAnswers, fetchNow, prepare, saveNotes, setStatus, skipSelected } from '@/app/actions';
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
const tasks = async () => (await pool.query<Task>(`SELECT * FROM tasks WHERE job_id = $1 OR job_id IS NULL ORDER BY id`, [id])).rows;
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
  // A missing or deleted job (dedupe can remove one mid-click) answers the form instead of throwing,
  // which would replace the whole page with app/error.tsx.
  it.each([
    ['setStatus', setStatus],
    ['saveNotes', saveNotes],
    ['prepare', prepare],
    ['aiReview', aiReview],
    ['draftAnswers', draftAnswers],
    ['clearAnswers', clearAnswers],
  ] as const)('%s answers a missing or unknown job with an error state, not a throw', async (_, action) => {
    expect(await action(null, form({ status: 'applied', questions: 'Q?' }))).toEqual({ ok: false, message: 'Missing job id' });
    expect(await action(null, form({ id: PREFIX + 'nope', status: 'applied', questions: 'Q?' }))).toEqual({
      ok: false,
      message: 'Unknown job',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(await tasks()).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('setStatus', () => {
  it('moves the job, logs the change with a trimmed note and refreshes', async () => {
    expect(await setStatus(null, form({ id, status: 'skipped', note: '  too junior  ' }))).toBeNull();
    const job = await getJob(id);
    expect(job!.status).toBe('skipped');
    expect(job!.applied_at).toBeNull();
    const events = await jobEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from_status: 'new', to_status: 'skipped', note: 'too junior' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('stores the optional skip reason in the same history row, and ignores it for other moves', async () => {
    await setStatus(null, form({ id, status: 'skipped', reason: 'seniority' }));
    expect((await jobEvents(id))[0]).toMatchObject({ to_status: 'skipped', reason: 'seniority' });
    await setStatus(null, form({ id, status: 'new', reason: 'stack' }));
    await setStatus(null, form({ id, status: 'skipped', reason: 'boredom' }));
    expect((await jobEvents(id)).map((e) => e.reason)).toEqual([null, null, 'seniority']);
  });

  it('stamps applied_at when marked applied, and stores an empty note as null', async () => {
    await setStatus(null, form({ id, status: 'applied', note: '   ' }));
    const job = await getJob(id);
    expect(job!.status).toBe('applied');
    expect(Date.now() - job!.applied_at!.getTime()).toBeLessThan(60_000);
    expect((await jobEvents(id))[0].note).toBeNull();
  });

  it('keeps applied_at on later moves', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    const appliedAt = (await getJob(id))!.applied_at;
    await setStatus(null, form({ id, status: 'interview' }));
    expect((await getJob(id))!.applied_at).toEqual(appliedAt);
    expect((await jobEvents(id)).map((e) => `${e.from_status}->${e.to_status}`)).toEqual(['applied->interview', 'new->applied']);
  });

  it.each(['filtered', 'bogus', ''])('refuses status %j without changing anything', async (status) => {
    expect(await setStatus(null, form({ id, status }))).toEqual({ ok: false, message: 'Invalid status' });
    expect((await getJob(id))!.status).toBe('new');
    expect(await jobEvents(id)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('skipSelected (bulk skip)', () => {
  const ids = (...list: string[]) => {
    const fd = new FormData();
    for (const v of list) fd.append('id', v);
    return fd;
  };

  it('skips every selected job in one go, logging each move with the one shared reason', async () => {
    const other = await insertJob({ id: 'act2', status: 'prepared' });
    const fd = ids(id, other, id); // a repeated id counts once
    fd.set('reason', 'seniority');
    expect(await skipSelected(null, fd)).toEqual({ ok: true, message: 'Skipped 2 jobs' });
    expect((await getJob(id))!.status).toBe('skipped');
    expect((await getJob(other))!.status).toBe('skipped');
    expect(await jobEvents(id)).toMatchObject([{ from_status: 'new', to_status: 'skipped', reason: 'seniority' }]);
    expect(await jobEvents(other)).toMatchObject([{ from_status: 'prepared', to_status: 'skipped', reason: 'seniority' }]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('stores no reason when none (or an unknown one) was picked', async () => {
    const fd = ids(id);
    fd.set('reason', 'boredom');
    expect(await skipSelected(null, fd)).toEqual({ ok: true, message: 'Skipped 1 job' });
    expect((await jobEvents(id))[0].reason).toBeNull();
  });

  it('ignores jobs that vanished mid-click and answers an error when none are left', async () => {
    expect(await skipSelected(null, ids(id, PREFIX + 'gone'))).toEqual({ ok: true, message: 'Skipped 1 job' });
    expect(await skipSelected(null, ids(PREFIX + 'gone'))).toEqual({ ok: false, message: 'Unknown jobs' });
    expect(await skipSelected(null, ids())).toEqual({ ok: false, message: 'No jobs selected' });
  });

  it('refuses more than a page of jobs at once', async () => {
    const many = ids(...Array.from({ length: 101 }, (_, i) => `${PREFIX}many${i}`));
    expect(await skipSelected(null, many)).toEqual({ ok: false, message: 'At most 100 jobs can be skipped at once' });
    expect((await getJob(id))!.status).toBe('new');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('skips expired and filtered-out jobs too, the other statuses still being triaged', async () => {
    const expired = await insertJob({ id: 'act-expired', status: 'expired' });
    const filtered = await insertJob({ id: 'act-filtered', status: 'filtered' });
    expect(await skipSelected(null, ids(expired, filtered))).toEqual({ ok: true, message: 'Skipped 2 jobs' });
    expect((await getJob(expired))!.status).toBe('skipped');
    expect((await jobEvents(filtered))[0]).toMatchObject({ from_status: 'filtered', to_status: 'skipped' });
  });

  it('leaves applied, interview, offer, rejected and skipped jobs as they were, logging nothing for them', async () => {
    // A search across every tab can put pipeline jobs in the selection: a bulk skip must never move them.
    const kept = ['applied', 'interview', 'offer', 'rejected', 'skipped'] as const;
    const keptIds = await Promise.all(kept.map((status) => insertJob({ id: `act-${status}`, status })));
    expect(await skipSelected(null, ids(id, ...keptIds))).toEqual({
      ok: true,
      message: 'Skipped 1 job (5 left as they were: already applied or skipped)',
    });
    expect((await getJob(id))!.status).toBe('skipped');
    for (const [i, keptId] of keptIds.entries()) {
      expect((await getJob(keptId))!.status).toBe(kept[i]);
      expect(await jobEvents(keptId)).toEqual([]);
    }
    const one = await insertJob({ id: 'act-new2', status: 'new' });
    expect(await skipSelected(null, ids(one, keptIds[0]))).toEqual({
      ok: true,
      message: 'Skipped 1 job (1 left as it was: already applied or skipped)',
    });
  });

  it('answers an error and changes nothing when none of the selected jobs can be skipped', async () => {
    const applied = await insertJob({ id: 'act-applied', status: 'applied' });
    const skipped = await insertJob({ id: 'act-skipped', status: 'skipped' });
    expect(await skipSelected(null, ids(applied, skipped))).toEqual({
      ok: false,
      message: 'Nothing skipped: the selected jobs are already applied or skipped',
    });
    expect(await skipSelected(null, ids(applied))).toEqual({
      ok: false,
      message: 'Nothing skipped: the selected job is already applied or skipped',
    });
    expect((await getJob(applied))!.status).toBe('applied');
    expect(await jobEvents(skipped)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('rolls everything back when a statement fails mid-transaction', async () => {
    const other = await insertJob({ id: 'act2', status: 'prepared' });
    // The job_events insert fails after the UPDATE ran: the transaction must leave both jobs untouched.
    const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
    let restore = () => {};
    const connectSpy = vi.spyOn(pool, 'connect').mockImplementationOnce((async () => {
      const client = await connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      const spy = vi
        .spyOn(client, 'query')
        .mockImplementation(((text: unknown, ...rest: unknown[]) =>
          typeof text === 'string' && text.includes('INSERT INTO job_events')
            ? Promise.reject(new DatabaseError('forced failure', 0, 'error'))
            : query(text, ...rest)) as never);
      restore = () => spy.mockRestore(); // the client goes back to the pool: later queries must not hit the spy
      return client;
    }) as never);
    try {
      expect(await skipSelected(null, ids(id, other))).toEqual({ ok: false, message: 'Database error: forced failure. Try again.' });
    } finally {
      restore();
      connectSpy.mockRestore();
    }
    expect((await getJob(id))!.status).toBe('new');
    expect((await getJob(other))!.status).toBe('prepared');
    expect(await jobEvents(id)).toEqual([]);
    expect(await jobEvents(other)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('saveNotes', () => {
  it('saves notes, capped at 5000 characters', async () => {
    expect(await saveNotes(null, form({ id, notes: 'x'.repeat(6000) }))).toBeNull();
    expect((await getJob(id))!.notes).toHaveLength(5000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('clears notes when empty', async () => {
    await saveNotes(null, form({ id, notes: 'Recruiter: Sam' }));
    expect((await getJob(id))!.notes).toBe('Recruiter: Sam');
    await saveNotes(null, form({ id, notes: '' }));
    expect((await getJob(id))!.notes).toBeNull();
  });
});

describe('prepare', () => {
  it('queues a prepare task, starts its worker and refreshes at once', async () => {
    expect(await prepare(null, form({ id }))).toBeNull();
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'prepare', job_id: id, args: {}, status: 'queued' });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('passes a valid CV version', async () => {
    await prepare(null, form({ id, cv: 'backend-lead-2' }));
    expect((await tasks())[0].args).toEqual({ cv: 'backend-lead-2' });
  });

  it('carries force for "Prepare anyway" on an expired job, with or without a CV version', async () => {
    await prepare(null, form({ id, force: 'true', cv: 'laravel' }));
    expect((await tasks())[0].args).toEqual({ cv: 'laravel', force: 'true' });
  });

  it.each(['1', 'on', 'false', ''])('ignores force=%j', async (force) => {
    await prepare(null, form({ id, force }));
    expect((await tasks())[0].args).toEqual({});
  });

  it.each(['../../etc', 'Backend', 'a b', 'x;rm', '', '--help', '-x'])('ignores an invalid CV version %j', async (cv) => {
    await prepare(null, form({ id, cv }));
    expect((await tasks())[0].args).toEqual({});
  });

  it('returns the running task on a second click instead of starting another', async () => {
    await prepare(null, form({ id }));
    await pool.query(`UPDATE tasks SET status = 'running' WHERE job_id = $1`, [id]);
    expect(await prepare(null, form({ id }))).toBeNull();
    expect(await tasks()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('answers with the refusal (instead of dropping the click) while another task changes the CV', async () => {
    await pool.query(`INSERT INTO tasks (kind, job_id) VALUES ('cv_template', $1)`, [id]);
    expect(await prepare(null, form({ id }))).toEqual({
      ok: false,
      message: 'The CV is being changed right now. Try again when it is done.',
    });
    expect((await tasks()).map((t) => t.kind)).toEqual(['cv_template']);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts again after the previous task finished', async () => {
    await prepare(null, form({ id }));
    await pool.query(`UPDATE tasks SET status = 'done' WHERE job_id = $1`, [id]);
    await prepare(null, form({ id }));
    expect((await tasks()).map((t) => t.status)).toEqual(['done', 'queued']);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('aiReview', () => {
  it('queues an ai_review task and refreshes', async () => {
    await aiReview(null, form({ id }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'ai_review', job_id: id, status: 'queued' });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('runs alongside a prepare task for the same job', async () => {
    await prepare(null, form({ id }));
    await aiReview(null, form({ id }));
    expect((await tasks()).map((t) => t.kind)).toEqual(['prepare', 'ai_review']);
  });
});

describe('draftAnswers', () => {
  it('queues an answers task with the trimmed questions in its args', async () => {
    await draftAnswers(null, form({ id, questions: '  Why us?\nVisa needed?  ' }));
    const [t] = await tasks();
    expect(t).toMatchObject({ kind: 'answers', job_id: id, args: { questions: 'Why us?\nVisa needed?' } });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(spawnedFor(t));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('caps the questions at 8000 characters', async () => {
    await draftAnswers(null, form({ id, questions: 'q'.repeat(9000) }));
    expect((await tasks())[0].args.questions).toHaveLength(8000);
  });

  it.each(['', '   \n  '])('does nothing for empty questions %j', async (questions) => {
    expect(await draftAnswers(null, form({ id, questions }))).toBeNull();
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when the questions field is absent', async () => {
    await draftAnswers(null, form({ id }));
    expect(await tasks()).toEqual([]);
  });
});

describe('clearAnswers', () => {
  it('empties the drafted answers', async () => {
    await insertJob({ id: 'with-answers', form_answers: [{ question: 'Q', answer: 'A', needs_input: false, note: '' }] });
    await clearAnswers(null, form({ id: PREFIX + 'with-answers' }));
    expect((await getJob(PREFIX + 'with-answers'))!.form_answers).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('fetchNow', () => {
  it('queues one fetch task and returns at once', async () => {
    expect(await fetchNow()).toBeNull();
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
    await prepare(null, form({ id }));
    const [t] = await tasks();
    await pool.query(`UPDATE tasks SET status = 'failed', error = 'boom' WHERE id = $1`, [t.id]);
    expect(await dismissTask(null, form({ task: String(t.id) }))).toBeNull();
    expect((await tasks())[0].dismissed).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not touch a running task', async () => {
    await prepare(null, form({ id }));
    await dismissTask(null, form({ task: String((await tasks())[0].id) }));
    expect((await tasks())[0]).toMatchObject({ status: 'queued', dismissed: false });
  });

  it.each(['', 'abc', '-1', '1.5', '0'])('refuses task id %j with an error state, not a throw', async (task) => {
    expect(await dismissTask(null, form({ task }))).toEqual({ ok: false, message: 'Invalid task' });
  });
});
