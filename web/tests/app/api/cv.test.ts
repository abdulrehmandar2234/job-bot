import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// lib/bot.ts resolves BOT_ROOT from the working directory (web/..) at import time, so point the cwd at a
// temp "web" folder while importing: the real cvPath/cvFileName (lib/cv-templates.ts) then read a temp config.json and CVs.
const root = mkdtempSync(join(tmpdir(), 'talaash-web-cv-'));
let GET: typeof import('@/app/api/cv/[version]/route').GET;

beforeAll(async () => {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ cvFileName: 'Jane_Doe_CV.pdf' }));
  vi.stubEnv('JOB_BOT_CONFIG', join(root, 'config.json')); // not the shipped defaults tests/setup.ts points at
  mkdirSync(join(root, 'cv', 'default'), { recursive: true });
  mkdirSync(join(root, 'cv', 'versions', 'laravel-lead'), { recursive: true });
  writeFileSync(join(root, 'cv', 'default', 'Jane_Doe_CV.pdf'), '%PDF default');
  writeFileSync(join(root, 'cv', 'versions', 'laravel-lead', 'Jane_Doe_CV.pdf'), '%PDF laravel');

  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'web'));
  try {
    ({ GET } = await import('@/app/api/cv/[version]/route'));
    const { BOT_ROOT } = await import('@/lib/bot');
    expect(BOT_ROOT).toBe(root);
  } finally {
    cwd.mockRestore();
  }
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const get = (version: string, query = '', origin?: string) =>
  GET(new NextRequest(`http://localhost:3100/api/cv/${encodeURIComponent(version)}${query}`, { headers: origin ? { origin } : {} }), {
    params: Promise.resolve({ version }),
  } as Parameters<typeof GET>[1]);

describe('GET /api/cv/[version]', () => {
  it('serves the default CV inline as an uncached PDF', async () => {
    const res = await get('default');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="Jane_Doe_CV.pdf"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('%PDF default');
  });

  it('serves a tailored version', async () => {
    expect(await (await get('laravel-lead')).text()).toBe('%PDF laravel');
  });

  it('sends it as an attachment with ?download', async () => {
    const res = await get('default', '?download');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Jane_Doe_CV.pdf"');
  });

  it('lets only the Talaash extension read it cross-origin (to attach it to a form), not other sites', async () => {
    const { EXTENSION_ID } = await import('@/lib/extension');
    const ext = `chrome-extension://${EXTENSION_ID}`;
    const res = await get('default', '?download', ext);
    expect(res.headers.get('access-control-allow-origin')).toBe(ext);
    expect(res.headers.get('vary')).toBe('Origin');
    for (const origin of [undefined, 'https://evil.example', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop']) {
      expect((await get('default', '', origin)).headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('returns 404 for a version without a CV', async () => {
    const res = await get('no-such-version');
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('CV not found');
  });

  it.each(['../default', '..', 'Laravel', 'a b', 'x/y', '', '-leading'])('rejects the version %j with 400', async (version) => {
    const res = await get(version);
    expect(res.status).toBe(400);
    expect(await res.text()).toBe('Bad version');
  });
});
