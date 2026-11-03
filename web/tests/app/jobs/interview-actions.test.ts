import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareInterview } from '@/app/jobs/[id]/interview-actions';
import { spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import type { Task } from '@/lib/tasks';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module, but never start a bot worker process.
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  spawnBot: vi.fn(),
}));

const spawn = vi.mocked(spawnBot);
const id = PREFIX + 'interview';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const tasks = async () => (await pool.query<Task>('SELECT * FROM tasks WHERE job_id = $1 ORDER BY id', [id])).rows;

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'interview' });
  vi.clearAllMocks();
});
afterAll(closeDb);

describe('prepareInterview', () => {
  it('queues a prep task, starts its worker and refreshes at once', async () => {
    expect(await prepareInterview(null, form({ id }))).toBeNull();
    const [task] = await tasks();
    expect(task).toMatchObject({ kind: 'prep', job_id: id, status: 'queued', args: {} });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(task.id)]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not start a second prep while one is queued or running', async () => {
    await prepareInterview(null, form({ id }));
    await prepareInterview(null, form({ id }));
    expect(await tasks()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('answers a missing or unknown job with an error state, without queueing anything', async () => {
    expect(await prepareInterview(null, form({}))).toEqual({ ok: false, message: 'Missing job id' });
    expect(await prepareInterview(null, form({ id: PREFIX + 'nope' }))).toEqual({ ok: false, message: 'Unknown job' });
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
