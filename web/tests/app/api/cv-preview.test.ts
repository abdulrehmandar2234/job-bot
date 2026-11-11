import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// lib/bot.ts resolves BOT_ROOT from the working directory (web/..) at import time, so point the cwd at a temp
// "web" folder while importing; runBot is mocked and "prints" the preview.
const root = mkdtempSync(join(tmpdir(), 'talaash-web-preview-'));
const pdfPath = join(root, 'data', 'previews', 'compact.pdf');
const runBot = vi.fn();
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<typeof import('@/lib/bot')>()), runBot: (...a: unknown[]) => runBot(...a) }));
let GET: typeof import('@/app/api/cv/preview/[template]/route').GET;

const savedDataDir = process.env.JOB_BOT_DATA_DIR;
beforeAll(async () => {
  process.env.JOB_BOT_DATA_DIR = join(root, 'data'); // read on every call (src/settings.ts dataDir)
  mkdirSync(join(root, 'data', 'previews'), { recursive: true });
  writeFileSync(pdfPath, '%PDF-1.7 preview');
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'web'));
  try {
    ({ GET } = await import('@/app/api/cv/preview/[template]/route'));
  } finally {
    cwd.mockRestore();
  }
});
beforeEach(() => runBot.mockReset());
afterAll(() => {
  process.env.JOB_BOT_DATA_DIR = savedDataDir;
  rmSync(root, { recursive: true, force: true });
});

const get = (template: string, query = '') =>
  GET(new NextRequest(`http://localhost:3100/api/cv/preview/${encodeURIComponent(template)}${query}`), {
    params: Promise.resolve({ template }),
  } as Parameters<typeof GET>[1]);

describe('GET /api/cv/preview/[template]', () => {
  it('renders the master CV in the template as inline HTML (`bot cv:preview <template>`), with no scripts allowed', async () => {
    runBot.mockResolvedValue('<!doctype html><html><head></head><body><h1>Jane Doe</h1></body></html>');
    const res = await get('modern');
    expect(runBot).toHaveBeenCalledExactlyOnceWith(['cv:preview', 'modern'], 60_000);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toMatch(/<h1>Jane Doe<\/h1>/);
    expect(html).toContain(
      '<style>html { background: #fff; color-scheme: light; } body { max-width: 210mm; margin: 0 auto !important; }</style></head>',
    );
  });

  it('with ?pdf serves the PDF the bot printed to data/previews, inline', async () => {
    runBot.mockResolvedValue(`PDF        : ${pdfPath}\n`);
    const res = await get('compact', '?pdf');
    expect(runBot).toHaveBeenCalledExactlyOnceWith(['cv:preview', 'compact', '--pdf'], 60_000);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="cv-preview-compact.pdf"');
    expect(await res.text()).toBe('%PDF-1.7 preview');
  });

  it('refuses a template that is not in the list, without running the bot', async () => {
    for (const t of ['fancy', 'Modern', '', '..', 'classic;rm', '--pdf']) {
      const res = await get(t);
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('Unknown CV template');
    }
    expect(runBot).not.toHaveBeenCalled();
  });

  it('never serves a file outside data/previews', async () => {
    runBot.mockResolvedValue('PDF        : /etc/passwd\n');
    expect((await get('classic', '?pdf')).status).toBe(500);
    runBot.mockResolvedValue(`PDF        : ${join(root, 'data', 'previews', '..', 'secret.pdf')}\n`);
    expect((await get('classic', '?pdf')).status).toBe(500);
  });

  it('reports a failed render', async () => {
    runBot.mockRejectedValueOnce(new Error('no chrome'));
    const res = await get('classic', '?pdf');
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/Chrome/);
  });
});
