import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiReview, clearAnswers, draftAnswers, fetchNow, prepare, saveNotes, setStatus } from '@/app/actions';
import { BOT_ROOT, runBot } from '@/lib/bot';
import { getJob, jobEvents } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module, but never spawn the bot CLI and write files into a temp "bot root".
vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/bot')>()),
    BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-actions-')),
    runBot: vi.fn(),
  };
});

const bot = vi.mocked(runBot);
const id = PREFIX + 'act';
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'new' });
  vi.clearAllMocks();
  bot.mockResolvedValue('');
});
afterAll(async () => {
  await closeDb();
  rmSync(BOT_ROOT, { recursive: true, force: true });
});

describe('job id validation (shared by every action)', () => {
  it.each([
    ['setStatus', setStatus], ['saveNotes', saveNotes], ['prepare', prepare], ['aiReview', aiReview],
    ['draftAnswers', draftAnswers], ['clearAnswers', clearAnswers],
  ] as const)('%s rejects a missing or unknown job', async (_, action) => {
    await expect(action(form({ status: 'applied', questions: 'Q?' }))).rejects.toThrow('Missing job id');
    await expect(action(form({ id: PREFIX + 'nope', status: 'applied', questions: 'Q?' }))).rejects.toThrow('Unknown job');
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('setStatus', () => {
  it('moves the job, logs the change with a trimmed note and refreshes', async () => {
    await setStatus(form({ id, status: 'skipped', note: '  too junior  ' }));
    const job = await getJob(id);
    expect(job!.status).toBe('skipped');
    expect(job!.applied_at).toBeNull();
    const events = await jobEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ from_status: 'new', to_status: 'skipped', note: 'too junior' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('stamps applied_at when marked applied, and stores an empty note as null', async () => {
    await setStatus(form({ id, status: 'applied', note: '   ' }));
    const job = await getJob(id);
    expect(job!.status).toBe('applied');
    expect(Date.now() - job!.applied_at!.getTime()).toBeLessThan(60_000);
    expect((await jobEvents(id))[0].note).toBeNull();
  });

  it('keeps applied_at on later moves', async () => {
    await setStatus(form({ id, status: 'applied' }));
    const appliedAt = (await getJob(id))!.applied_at;
    await setStatus(form({ id, status: 'interview' }));
    expect((await getJob(id))!.applied_at).toEqual(appliedAt);
    expect((await jobEvents(id)).map((e) => `${e.from_status}->${e.to_status}`)).toEqual(['applied->interview', 'new->applied']);
  });

  it.each(['filtered', 'bogus', ''])('rejects status %j without changing anything', async (status) => {
    await expect(setStatus(form({ id, status }))).rejects.toThrow('Invalid status');
    expect((await getJob(id))!.status).toBe('new');
    expect(await jobEvents(id)).toEqual([]);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('saveNotes', () => {
  it('saves notes, capped at 5000 characters', async () => {
    await saveNotes(form({ id, notes: 'x'.repeat(6000) }));
    expect((await getJob(id))!.notes).toHaveLength(5000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('clears notes when empty', async () => {
    await saveNotes(form({ id, notes: 'Recruiter: Sam' }));
    expect((await getJob(id))!.notes).toBe('Recruiter: Sam');
    await saveNotes(form({ id, notes: '' }));
    expect((await getJob(id))!.notes).toBeNull();
  });
});

describe('prepare', () => {
  it('runs `prepare <id>` with a 4 minute timeout and refreshes', async () => {
    await prepare(form({ id }));
    expect(bot).toHaveBeenCalledWith(['prepare', id], 240_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('passes a valid CV version', async () => {
    await prepare(form({ id, cv: 'backend-lead-2' }));
    expect(bot).toHaveBeenCalledWith(['prepare', id, '--cv', 'backend-lead-2'], 240_000);
  });

  it.each(['../../etc', 'Backend', 'a b', 'x;rm', '', '--help', '-x'])('ignores an invalid CV version %j', async (cv) => {
    await prepare(form({ id, cv }));
    expect(bot).toHaveBeenCalledWith(['prepare', id], 240_000);
  });

  it('does not refresh when the bot fails', async () => {
    bot.mockRejectedValue(new Error('claude CLI missing'));
    await expect(prepare(form({ id }))).rejects.toThrow('claude CLI missing');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('aiReview', () => {
  it('runs `ai:score --id <id>` and refreshes', async () => {
    await aiReview(form({ id }));
    expect(bot).toHaveBeenCalledWith(['ai:score', '--id', id], 240_000);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('draftAnswers', () => {
  const questionsDir = () => join(BOT_ROOT, 'data', 'questions');

  it('writes the questions to a temp file, runs `answer <id> --file <path>`, then deletes it', async () => {
    let seen: { path: string; content: string; existed: boolean } | undefined;
    bot.mockImplementation(async (args) => {
      const path = args[3];
      seen = { path, content: readFileSync(path, 'utf8'), existed: existsSync(path) };
      return '';
    });
    await draftAnswers(form({ id, questions: '  Why us?\nVisa needed?  ' }));

    expect(bot).toHaveBeenCalledOnce();
    const [args, timeout] = bot.mock.calls[0];
    expect(args.slice(0, 3)).toEqual(['answer', id, '--file']);
    expect(timeout).toBe(240_000);
    expect(seen!.path.startsWith(questionsDir())).toBe(true);
    expect(seen!.path).toMatch(/[0-9a-f-]{36}\.txt$/);
    expect(seen!.content).toBe('Why us?\nVisa needed?');
    expect(existsSync(seen!.path)).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('caps the questions at 8000 characters', async () => {
    let length = 0;
    bot.mockImplementation(async (args) => { length = readFileSync(args[3], 'utf8').length; return ''; });
    await draftAnswers(form({ id, questions: 'q'.repeat(9000) }));
    expect(length).toBe(8000);
  });

  it('deletes the file even when the bot fails, and does not refresh', async () => {
    let path = '';
    bot.mockImplementation(async (args) => { path = args[3]; throw new Error('timeout'); });
    await expect(draftAnswers(form({ id, questions: 'Why us?' }))).rejects.toThrow('timeout');
    expect(path).not.toBe('');
    expect(existsSync(path)).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each(['', '   \n  '])('does nothing for empty questions %j', async (questions) => {
    const before = existsSync(questionsDir()) ? readdirSync(questionsDir()).length : 0;
    await draftAnswers(form({ id, questions }));
    expect(bot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(questionsDir()) ? readdirSync(questionsDir()).length : 0).toBe(before);
  });

  it('does nothing when the questions field is absent', async () => {
    await draftAnswers(form({ id }));
    expect(bot).not.toHaveBeenCalled();
  });
});

describe('clearAnswers', () => {
  it('empties the drafted answers', async () => {
    await insertJob({ id: 'with-answers', form_answers: [{ question: 'Q', answer: 'A', needs_input: false, note: '' }] });
    await clearAnswers(form({ id: PREFIX + 'with-answers' }));
    expect((await getJob(PREFIX + 'with-answers'))!.form_answers).toEqual([]);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe('fetchNow', () => {
  it('runs `fetch` with a 20 minute timeout', async () => {
    await fetchNow();
    expect(bot).toHaveBeenCalledWith(['fetch'], 20 * 60_000);
    expect(refresh).toHaveBeenCalledOnce();
  });
});
