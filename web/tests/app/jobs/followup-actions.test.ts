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
    expect(await draftFollowUp(null, form({ id }))).toBeNull();
    const [task] = await tasks();
    expect(task).toMatchObject({ kind: 'follow_up', job_id: id, status: 'queued', args: {} });
    expect(spawn).toHaveBeenCalledExactlyOnceWith(['task:run', String(task.id)]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not start a second draft while one is queued', async () => {
    await draftFollowUp(null, form({ id }));
    await draftFollowUp(null, form({ id }));
    expect(await tasks()).toHaveLength(1);
    expect(spawn).toHaveBeenCalledOnce();
  });
});

describe('markFollowedUp', () => {
  it('runs `bot followed-up <id>` with a 30s timeout, then refreshes', async () => {
    expect(await markFollowedUp(null, form({ id }))).toBeNull();
    expect(bot).toHaveBeenCalledExactlyOnceWith(['followed-up', id], 30_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('answers a failed bot run with an error state (no refresh), not a throw into app/error.tsx', async () => {
    // What execFile rejects with on a non-zero exit: the thrown error is on stderr, after Node's noise.
    bot.mockRejectedValue(Object.assign(new Error('Command failed'), { stderr: 'file:///x\nError: No DB\n    at main' }));
    expect(await markFollowedUp(null, form({ id }))).toEqual({ ok: false, message: 'The bot failed: No DB' });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says so when the bot run timed out', async () => {
    bot.mockRejectedValue(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }));
    expect(await markFollowedUp(null, form({ id }))).toEqual({
      ok: false,
      message: 'The bot took too long and was stopped. Try again.',
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('both actions', () => {
  it('answer a missing or unknown job with an error state, without doing anything', async () => {
    for (const action of [draftFollowUp, markFollowedUp]) {
      expect(await action(null, form({}))).toEqual({ ok: false, message: 'Missing job id' });
      expect(await action(null, form({ id: PREFIX + 'nope' }))).toEqual({ ok: false, message: 'Unknown job' });
    }
    expect(await tasks()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});
