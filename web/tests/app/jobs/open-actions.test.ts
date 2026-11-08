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
    expect(await checkStillOpen(null, form({ id }))).toBeNull();
    expect(bot).toHaveBeenCalledExactlyOnceWith(['check:open', id], 60_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('answers a missing or unknown job with an error state, without running the bot', async () => {
    expect(await checkStillOpen(null, form({}))).toEqual({ ok: false, message: 'Missing job id' });
    expect(await checkStillOpen(null, form({ id: PREFIX + 'nope' }))).toEqual({ ok: false, message: 'Unknown job' });
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('answers a failed bot run with an error state (no refresh), not a throw into app/error.tsx', async () => {
    bot.mockRejectedValue(Object.assign(new Error('Command failed'), { stderr: 'Error: fetch failed\n    at main' }));
    expect(await checkStillOpen(null, form({ id }))).toEqual({ ok: false, message: 'The bot failed: fetch failed' });
    expect(refresh).not.toHaveBeenCalled();
  });
});
