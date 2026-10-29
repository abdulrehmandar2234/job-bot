import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/bayt-script/route';
import { BOT_ROOT } from '@/lib/bot';

vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return { ...(await importOriginal<typeof import('@/lib/bot')>()), BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-bayt-')) };
});

const script = join(BOT_ROOT, 'scripts', 'bayt-collect.js');
afterAll(() => rmSync(BOT_ROOT, { recursive: true, force: true }));

describe('GET /api/bayt-script', () => {
  it('fails when the collector script is missing', async () => {
    await expect(GET()).rejects.toThrow(/ENOENT/);
  });

  it('serves the collector as uncached JavaScript', async () => {
    mkdirSync(join(BOT_ROOT, 'scripts'), { recursive: true });
    writeFileSync(script, 'console.log("collect bayt");');
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('console.log("collect bayt");');
  });
});
