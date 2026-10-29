import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { draftFollowUp, markFollowedUp } from '@/app/jobs/[id]/followup-actions';
import { runBot, spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import type { Task } from '@/lib/tasks';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module, but never start the bot CLI.
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  spawnBot: vi.fn(),
  runBot: vi.fn(),
}));

const spawn = vi.mocked(spawnBot);
const bot = vi.mocked(runBot);
const id = PREFIX + 'follow-up';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const tasks = async () => (await pool.query<Task>('SELECT * FROM tasks WHERE job_id = $1 ORDER BY id', [id])).rows;

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'applied', applied_at: new Date() });
  vi.clearAllMocks();
  bot.mockResolvedValue('');
});
afterAll(closeDb);

describe('draftFollowUp', () => {
  it('queues a follow_up task, starts its worker and refreshes at once', async () => {
    await draftFollowUp(form({ id }));
    const [task] = await tasks();
    expect(task).toMatchObject({ kind: 'follow_up', job_id: id, status: 'queued', args: {} });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(task.id)]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not start a second draft while one is queued', async () => {
    await draftFollowUp(form({ id }));
    await draftFollowUp(form({ id }));
    expect(await tasks()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe('markFollowedUp', () => {
  it('runs `bot followed-up <id>` with a 30s timeout, then refreshes', async () => {
    await markFollowedUp(form({ id }));
    expect(bot).toHaveBeenCalledExactlyOnceWith(['followed-up', id], 30_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not refresh when the bot fails', async () => {
    bot.mockRejectedValue(new Error('Command failed'));
    await expect(markFollowedUp(form({ id }))).rejects.toThrow(/Command failed/);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('both actions', () => {
  it('reject a missing or unknown job without doing anything', async () => {
    for (const action of [draftFollowUp, markFollowedUp]) {
      await expect(action(form({}))).rejects.toThrow('Missing job id');
      await expect(action(form({ id: PREFIX + 'nope' }))).rejects.toThrow('Unknown job');
    }
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
