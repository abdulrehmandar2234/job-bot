import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchNow } from '@/app/actions';
import { BotStartError, spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import type { Task } from '@/lib/tasks';
import { cleanupDb, closeDb, ensureSchema } from '../helpers/db';

// When the bot cannot be started, the click answers "Could not start the bot: …" (not "the database is not
// reachable"), and the task just queued is failed with that reason at once instead of waiting for the stale check.
const fs = vi.hoisted(() => ({ fail: null as NodeJS.ErrnoException | null }));
const cp = vi.hoisted(() => ({ child: null as unknown, spawn: vi.fn() }));

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  const fail = (name: 'mkdirSync' | 'openSync') =>
    ((...args: unknown[]) => {
      if (fs.fail) throw fs.fail;
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    }) as never;
  return { ...real, default: real, mkdirSync: fail('mkdirSync'), openSync: fail('openSync') };
});
vi.mock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn: cp.spawn }));

const eacces = (syscall: string) =>
  Object.assign(new Error(`EACCES: permission denied, ${syscall} '/x/data/logs'`), { code: 'EACCES', syscall, errno: -13 });

/** The task's row once it left `queued` (the failure is recorded without blocking the click). */
async function settled(id: number) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await pool.query<Task>('SELECT * FROM tasks WHERE id = $1', [id]);
    if (rows[0].status !== 'queued') return rows[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${id} stayed queued`);
}
const newestFetch = async () =>
  (await pool.query<Task>(`SELECT * FROM tasks WHERE kind = 'fetch' AND job_id IS NULL ORDER BY id DESC LIMIT 1`)).rows[0];

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  fs.fail = null;
  cp.child = Object.assign(new EventEmitter(), { unref: vi.fn() });
  cp.spawn.mockReset().mockImplementation(() => cp.child);
});
afterAll(closeDb);

describe('spawnBot failures', () => {
  it('a log directory it cannot create: the action answers why and the task is failed', async () => {
    fs.fail = eacces('mkdir');
    const answer = await fetchNow();
    expect(answer).toEqual({ ok: false, message: expect.stringMatching(/^Could not start the bot: EACCES: permission denied, mkdir/) });
    expect(answer!.message).not.toMatch(/database/);
    expect(cp.spawn).not.toHaveBeenCalled();
    const task = await settled((await newestFetch()).id);
    expect(task).toMatchObject({ status: 'failed', error: answer!.message });
    expect(task.finished_at).not.toBeNull();
  });

  it('throws BotStartError, which is not mistaken for a database outage', () => {
    fs.fail = eacces('open');
    expect(() => spawnBot(['task:run', '999999999'])).toThrow(BotStartError);
  });

  it('a spawn error after the click answered (EACCES on node) fails the queued task with the reason', async () => {
    expect(await fetchNow()).toBeNull();
    const { id } = await newestFetch();
    (cp.child as EventEmitter).emit('error', eacces('spawn'));
    expect(await settled(id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^Could not start the bot: EACCES/) });
  });

  it('never touches a task whose worker already started', async () => {
    expect(await fetchNow()).toBeNull();
    const { id } = await newestFetch();
    await pool.query(`UPDATE tasks SET status = 'running', started_at = now() WHERE id = $1`, [id]);
    (cp.child as EventEmitter).emit('error', eacces('spawn'));
    await new Promise((r) => setTimeout(r, 100));
    expect((await pool.query<Task>('SELECT status, error FROM tasks WHERE id = $1', [id])).rows[0]).toEqual({
      status: 'running',
      error: null,
    });
  });
});
