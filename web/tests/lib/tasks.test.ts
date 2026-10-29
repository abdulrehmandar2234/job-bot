import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import {
  DEAD_WORKER_ERROR,
  enqueueTask,
  failDeadWorkers,
  KEEP_FINISHED_DAYS,
  openTasks,
  pidAlive,
  pruneFinished,
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
    expect(await failDeadWorkers()).toBe(1);
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
