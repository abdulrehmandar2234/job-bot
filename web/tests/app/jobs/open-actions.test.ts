import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkStillOpen } from '@/app/jobs/[id]/open-actions';
import { runBot } from '@/lib/bot';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Never spawn the bot CLI.
vi.mock('@/lib/bot', () => ({ runBot: vi.fn() }));

const bot = vi.mocked(runBot);
const id = PREFIX + 'open-check';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id });
  vi.clearAllMocks();
  bot.mockResolvedValue('');
});
afterAll(closeDb);

describe('checkStillOpen', () => {
  it('runs `bot check:open <id>` with a 60s timeout, then refreshes', async () => {
    await checkStillOpen(form({ id }));
    expect(bot).toHaveBeenCalledExactlyOnceWith(['check:open', id], 60_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects a missing or unknown job without running the bot', async () => {
    await expect(checkStillOpen(form({}))).rejects.toThrow('Missing job id');
    await expect(checkStillOpen(form({ id: PREFIX + 'nope' }))).rejects.toThrow('Unknown job');
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh when the bot fails', async () => {
    bot.mockRejectedValue(new Error('Command failed'));
    await expect(checkStillOpen(form({ id }))).rejects.toThrow(/Command failed/);
    expect(refresh).not.toHaveBeenCalled();
  });
});
