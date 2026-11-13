import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCvImport, discardCvImport, importCv } from '@/app/settings/actions';
import { runBot, spawnBot } from '@/lib/bot';
import { importDir } from '@/lib/cv-import';
import { pool } from '@/lib/db';
import { closeDb, ensureSchema } from '../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module (botDataDir is the temp JOB_BOT_DATA_DIR of web/tests/setup.ts), but never run the bot CLI.
vi.mock('@/lib/bot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bot')>()),
  runBot: vi.fn(async () => ''),
  spawnBot: vi.fn(),
}));

const bot = vi.mocked(runBot);
const form = (file?: File) => {
  const fd = new FormData();
  if (file) fd.set('cv', file);
  return fd;
};
const imports = () => pool.query<{ id: number; args: Record<string, string> }>(`SELECT id, args FROM tasks WHERE kind = 'cv_import'`);

beforeAll(ensureSchema);
beforeEach(async () => {
  vi.clearAllMocks();
  await pool.query(`DELETE FROM tasks WHERE kind = 'cv_import'`);
  rmSync(importDir(), { recursive: true, force: true });
});
afterAll(async () => {
  await pool.query(`DELETE FROM tasks WHERE kind = 'cv_import'`);
  await closeDb();
});

describe('importCv', () => {
  it('saves the upload in data/cv-import and queues one cv_import task for it', async () => {
    expect(await importCv(null, form(new File(['Jane Doe, PHP'], 'My CV.PDF')))).toBeNull();
    const file = join(importDir(), 'upload.pdf');
    expect(readFileSync(file, 'utf8')).toBe('Jane Doe, PHP');
    const { rows } = await imports();
    expect(rows).toEqual([{ id: expect.any(Number), args: { file, name: 'My CV.PDF' } }]);
    expect(spawnBot).toHaveBeenCalledExactlyOnceWith(['task:run', String(rows[0].id)]);
    expect(refresh).toHaveBeenCalledOnce();
    // A second upload while the first runs is refused: one import at a time.
    expect(await importCv(null, form(new File(['again'], 'cv.docx')))).toEqual({ ok: false, message: 'A CV import is already running.' });
  });

  it('refuses no file, an empty file, another type and a file over 5 MB, without queueing anything', async () => {
    expect(await importCv(null, form())).toEqual({ ok: false, message: 'Choose your CV file first.' });
    expect(await importCv(null, form(new File([], 'cv.pdf')))).toEqual({ ok: false, message: 'Choose your CV file first.' });
    expect(await importCv(null, form(new File(['x'], 'cv.odt')))).toEqual({ ok: false, message: 'Use a .pdf, .docx, .txt, .md file.' });
    expect(await importCv(null, form(new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'cv.pdf')))).toEqual({
      ok: false,
      message: 'The file is larger than 5 MB.',
    });
    expect((await imports()).rows).toEqual([]);
    expect(existsSync(importDir())).toBe(false);
  });
});

describe('applyCvImport and discardCvImport', () => {
  it('run cv:import --apply / --discard and say what happened', async () => {
    expect(await applyCvImport(null, form())).toMatchObject({ ok: true, message: expect.stringContaining('Saved as your master CV') });
    expect(bot).toHaveBeenLastCalledWith(['cv:import', '--apply'], 30_000);
    expect(await discardCvImport(null, form())).toEqual({ ok: true, message: 'Draft removed. Your master CV is unchanged.' });
    expect(bot).toHaveBeenLastCalledWith(['cv:import', '--discard'], 30_000);
  });

  it("reports the bot's own error when applying fails", async () => {
    bot.mockRejectedValueOnce(Object.assign(new Error('exit 1'), { stderr: 'There is no imported CV to apply.\n' }));
    expect(await applyCvImport(null, form())).toEqual({ ok: false, message: 'The bot failed: There is no imported CV to apply.' });
    expect(refresh).not.toHaveBeenCalled();
  });
});
