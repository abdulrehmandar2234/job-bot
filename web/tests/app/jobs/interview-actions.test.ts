import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareInterview } from '@/app/jobs/[id]/interview-actions';
import { runBot } from '@/lib/bot';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Never spawn the bot CLI.
vi.mock('@/lib/bot', () => ({ runBot: vi.fn() }));

const bot = vi.mocked(runBot);
const id = PREFIX + 'interview';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'interview' });
  vi.clearAllMocks();
  bot.mockResolvedValue('');
});
afterAll(closeDb);

describe('prepareInterview', () => {
  it('runs `bot prep <id>` with a long timeout, then refreshes', async () => {
    await prepareInterview(form({ id }));
    expect(bot).toHaveBeenCalledExactlyOnceWith(['prep', id], 240_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('rejects a missing or unknown job without running the bot', async () => {
    await expect(prepareInterview(form({}))).rejects.toThrow('Missing job id');
    await expect(prepareInterview(form({ id: PREFIX + 'nope' }))).rejects.toThrow('Unknown job');
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not refresh when the bot fails', async () => {
    bot.mockRejectedValue(new Error('Command failed: usage limit reached'));
    await expect(prepareInterview(form({ id }))).rejects.toThrow(/usage limit/);
    expect(refresh).not.toHaveBeenCalled();
  });
});
