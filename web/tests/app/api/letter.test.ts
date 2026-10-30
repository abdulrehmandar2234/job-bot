import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

// lib/bot.ts resolves BOT_ROOT from the working directory (web/..) at import time, so point the cwd at a temp
// "web" folder while importing; runBot is mocked and "prints" a PDF into the temp applications/ folder.
const root = mkdtempSync(join(tmpdir(), 'job-bot-web-letter-'));
const pdfPath = join(root, 'applications', '2026-10-30-acme-engineer', 'cover-letter.pdf');
const runBot = vi.fn();
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<typeof import('@/lib/bot')>()), runBot: (...a: unknown[]) => runBot(...a) }));
let GET: typeof import('@/app/api/letter/[id]/route').GET;
let letterFileName: typeof import('@/app/api/letter/[id]/route').letterFileName;

beforeAll(async () => {
  await ensureSchema();
  mkdirSync(join(root, 'applications', '2026-10-30-acme-engineer'), { recursive: true });
  writeFileSync(pdfPath, '%PDF-1.7 letter');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'web'));
  try {
    ({ GET, letterFileName } = await import('@/app/api/letter/[id]/route'));
  } finally {
    cwd.mockRestore();
  }
});
beforeEach(async () => {
  await cleanupDb();
  runBot.mockReset();
  runBot.mockResolvedValue(`PDF        : ${pdfPath}\n`);
});
afterAll(async () => {
  await closeDb();
  rmSync(root, { recursive: true, force: true });
});

const get = (id: string) =>
  GET(new NextRequest(`http://localhost:3100/api/letter/${encodeURIComponent(id)}`), {
    params: Promise.resolve({ id: encodeURIComponent(id) }),
  } as Parameters<typeof GET>[1]);

describe('GET /api/letter/[id]', () => {
  it('prints the letter with `bot letter:pdf <id>` and downloads it', async () => {
    const id = await insertJob({ id: 'letter-1', company: 'Acme & Co.', cover_letter: 'Dear Acme' });
    const res = await get(id);
    expect(runBot).toHaveBeenCalledExactlyOnceWith(['letter:pdf', id], 60_000);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Cover_Letter_Acme_Co.pdf"');
    expect(await res.text()).toBe('%PDF-1.7 letter');
  });

  it('404s for an unknown job or a job without a letter, without running the bot', async () => {
    expect((await get(PREFIX + 'nope')).status).toBe(404);
    const id = await insertJob({ id: 'letter-none' });
    const res = await get(id);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/Write letter/);
    expect(runBot).not.toHaveBeenCalled();
  });

  it('never serves a file outside applications/, and reports a failed print', async () => {
    const id = await insertJob({ id: 'letter-2', cover_letter: 'Dear Acme' });
    runBot.mockResolvedValue('PDF        : /etc/passwd\n');
    expect((await get(id)).status).toBe(500);
    runBot.mockResolvedValue(`PDF        : ${join(root, 'applications', '..', 'secret.pdf')}\n`);
    expect((await get(id)).status).toBe(500);
    runBot.mockRejectedValue(new Error('Chrome missing'));
    const res = await get(id);
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Could not print the cover letter/);
  });

  it('builds a safe file name', () => {
    expect(letterFileName('Acme & Co.')).toBe('Cover_Letter_Acme_Co.pdf');
    expect(letterFileName('../../x')).toBe('Cover_Letter_x.pdf');
    expect(letterFileName('***')).toBe('Cover_Letter_Job.pdf');
  });
});
