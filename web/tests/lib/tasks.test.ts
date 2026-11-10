import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import {
  CvBusyError,
  DEAD_WORKER_ERROR,
  dismissTask,
  enqueueTask,
  EXPIRE_EVERY_MS,
  failDeadWorkers,
  KEEP_FINISHED_DAYS,
  openTasks,
  pidAlive,
  pruneFinished,
  resetExpireThrottle,
  type Task,
} from '@/lib/tasks';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

// Keep the real module, but never start a bot worker process.
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  spawnBot: vi.fn(),
}));

const id = PREFIX + 'tasks';
/** The pid of a process that has exited (and been reaped), so nothing answers to it. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const getTask = async (taskId: number) => (await pool.query<Task>('SELECT * FROM tasks WHERE id = $1', [taskId])).rows[0];
/** A task for our job, as a worker would have left it. */
async function addTask(kind: string, status: string, extra: { pid?: number; ageDays?: number } = {}) {
  const {
    rows: [t],
  } = await pool.query<Task>(
    `INSERT INTO tasks (kind, job_id, status, pid, started_at, deadline, created_at, finished_at)
     VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour', now() - make_interval(days => $5),
       CASE WHEN $3 IN ('done', 'failed') THEN now() - make_interval(days => $5) END)
     RETURNING *`,
    [kind, id, status, extra.pid ?? null, extra.ageDays ?? 0],
  );
  return t;
}

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'new' });
  vi.clearAllMocks();
  resetExpireThrottle(); // each test sees the stale check run again
});
afterAll(closeDb);

describe('dead workers', () => {
  it('pidAlive: this process and one we may not signal are alive, an exited one is not', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(1)).toBe(true); // launchd: EPERM means it exists
    expect(pidAlive(deadPid())).toBe(false);
  });

  it('fails running tasks whose pid is gone, and leaves live and pid-less ones', async () => {
    const dead = await addTask('prepare', 'running', { pid: deadPid() });
    const live = await addTask('ai_review', 'running', { pid: process.pid });
    const noPid = await addTask('answers', 'running');
    // The table is shared: a dead-pid row left by an aborted earlier run is failed too, so count at least ours.
    expect(await failDeadWorkers()).toBeGreaterThanOrEqual(1);
    expect(await getTask(dead.id)).toMatchObject({ status: 'failed', error: DEAD_WORKER_ERROR });
    expect((await getTask(live.id)).status).toBe('running');
    expect((await getTask(noPid.id)).status).toBe('running');
  });

  it('listing shows a dead worker as failed at once', async () => {
    const dead = await addTask('prep', 'running', { pid: deadPid() });
    const [view] = await openTasks(id);
    expect(view).toMatchObject({ id: dead.id, status: 'failed', error: DEAD_WORKER_ERROR });
  });

  it('enqueueing fails a dead worker first, so the same work starts again', async () => {
    const dead = await addTask('prep', 'running', { pid: deadPid() });
    const { task, created } = await enqueueTask('prep', id);
    expect(created).toBe(true);
    expect(task.id).not.toBe(dead.id);
    expect(spawnBot).toHaveBeenCalledExactlyOnceWith(['task:run', String(task.id)]);
    expect((await getTask(dead.id)).status).toBe('failed');
  });
});

describe('one CV change per job', () => {
  const activeKinds = async () =>
    (
      await pool.query<{ kind: string }>(`SELECT kind FROM tasks WHERE job_id = $1 AND status IN ('queued', 'running') ORDER BY id`, [id])
    ).rows.map((r) => r.kind);

  it('refuses a second, different CV-changing kind for the same job (the insert itself checks)', async () => {
    expect((await enqueueTask('cv_feedback', id, { feedback: 'shorter' })).created).toBe(true);
    await expect(enqueueTask('cv_template', id, { template: 'modern' })).rejects.toThrow(CvBusyError);
    await expect(enqueueTask('prepare', id)).rejects.toThrow('The CV is being changed right now. Try again when it is done.');
    await expect(enqueueTask('tailored_cv', id)).rejects.toThrow(CvBusyError);
    expect(await activeKinds()).toEqual(['cv_feedback']);
    expect(spawnBot).toHaveBeenCalledOnce();
  });

  it('the same kind again returns the running task, as before', async () => {
    const first = await enqueueTask('cv_template', id, { template: 'modern' });
    const again = await enqueueTask('cv_template', id, { template: 'compact' });
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(first.task.id);
    expect(spawnBot).toHaveBeenCalledOnce();
  });

  it('a finished CV task blocks nothing, and non-CV kinds run alongside a CV change', async () => {
    const { task } = await enqueueTask('cv_template', id, { template: 'modern' });
    expect((await enqueueTask('ai_review', id)).created).toBe(true);
    expect((await enqueueTask('letter', id)).created).toBe(true);
    await pool.query(`UPDATE tasks SET status = 'done', finished_at = now() WHERE id = $1`, [task.id]);
    expect((await enqueueTask('prepare', id)).created).toBe(true);
  });
});

describe('stale-check throttle', () => {
  it('openTasks runs the stale check at most once per window; enqueueTask always runs it', async () => {
    const spy = vi.spyOn(pool, 'query');
    const expires = () => spy.mock.calls.filter(([sql]) => String(sql).includes('expire_stale_tasks')).length;
    await openTasks(id);
    expect(expires()).toBe(1);
    await openTasks(id);
    await openTasks(id);
    expect(expires()).toBe(1); // within the window: one DB pass, no extra round-trips per poll
    await enqueueTask('letter', id);
    expect(expires()).toBe(2); // enqueueing never skips it (a dead same-kind worker must fail first)
    const later = performance.now() + EXPIRE_EVERY_MS + 1;
    const now = vi.spyOn(performance, 'now').mockReturnValue(later);
    try {
      await openTasks(id);
      expect(expires()).toBe(3); // the window passed: a stale task still fails eventually
    } finally {
      now.mockRestore();
      spy.mockRestore();
    }
  });

  it('never reads the wall clock: Next refuses Date.now() while it prerenders a page that lists tasks', async () => {
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now() during prerender');
    });
    try {
      await expect(openTasks(id)).resolves.toEqual([]);
      await expect(openTasks(id)).resolves.toEqual([]); // the throttled path too
    } finally {
      clock.mockRestore();
    }
  });

  it('runs the stale check on the first look, however young the process is', async () => {
    const spy = vi.spyOn(pool, 'query');
    const young = vi.spyOn(performance, 'now').mockReturnValue(5); // 5 ms after start, inside one window from 0
    try {
      await openTasks(id);
      expect(spy.mock.calls.some(([sql]) => String(sql).includes('expire_stale_tasks'))).toBe(true);
    } finally {
      young.mockRestore();
      spy.mockRestore();
    }
  });

  it('a dead worker still fails on the first look after the window', async () => {
    const dead = await addTask('prep', 'running', { pid: deadPid() });
    await openTasks(id); // first look in this window
    expect((await getTask(dead.id)).status).toBe('failed');
  });
});

describe('finished notice', () => {
  it('openTasks lists a recently finished task until dismissed; dismissed it never comes back', async () => {
    const done = await addTask('letter', 'done');
    const old = await addTask('summary', 'done', { ageDays: 1 });
    let ids = (await openTasks(id)).map((t) => t.id);
    expect(ids).toContain(done.id);
    expect(ids).not.toContain(old.id); // too old for the notice
    expect(await dismissTask(done.id)).toBe(true);
    ids = (await openTasks(id)).map((t) => t.id);
    expect(ids).not.toContain(done.id);
  });

  it('dismissing the shown notice also dismisses older finished tasks, so the next one does not pop up', async () => {
    const older = await addTask('letter', 'done');
    const newer = await addTask('summary', 'done');
    await pool.query(`UPDATE tasks SET finished_at = now() - interval '10 minutes' WHERE id = $1`, [older.id]);
    const failed = await addTask('prep', 'failed');
    expect(await dismissTask(newer.id)).toBe(true);
    const ids = (await openTasks(id)).map((t) => t.id);
    expect(ids).not.toContain(newer.id);
    expect(ids).not.toContain(older.id);
    expect(ids).toContain(failed.id); // failures keep their own Dismiss
  });

  it('dismissTask hides done and failed tasks, never active ones', async () => {
    const queued = await addTask('letter', 'queued');
    expect(await dismissTask(queued.id)).toBe(false);
    const failed = await addTask('summary', 'failed');
    expect(await dismissTask(failed.id)).toBe(true);
  });
});

describe('pruning', () => {
  it(`deletes done and failed tasks older than ${KEEP_FINISHED_DAYS} days, nothing else`, async () => {
    const oldDone = await addTask('prepare', 'done', { ageDays: KEEP_FINISHED_DAYS + 1 });
    const oldFailed = await addTask('ai_review', 'failed', { ageDays: KEEP_FINISHED_DAYS + 5 });
    const recent = await addTask('answers', 'done', { ageDays: KEEP_FINISHED_DAYS - 1 });
    const running = await addTask('prep', 'running', { pid: process.pid, ageDays: KEEP_FINISHED_DAYS + 10 });
    expect(await pruneFinished()).toBeGreaterThanOrEqual(2);
    expect(await getTask(oldDone.id)).toBeUndefined();
    expect(await getTask(oldFailed.id)).toBeUndefined();
    expect(await getTask(recent.id)).toBeDefined();
    expect(await getTask(running.id)).toBeDefined();
  });

  it('enqueueing prunes', async () => {
    const old = await addTask('ai_review', 'done', { ageDays: KEEP_FINISHED_DAYS + 1 });
    await enqueueTask('prepare', id);
    expect(await getTask(old.id)).toBeUndefined();
  });
});
