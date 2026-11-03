import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/bayt-script/route';
import { BOT_ROOT } from '@/lib/bot';
import { importToken } from '@/lib/extension';

vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return { ...(await importOriginal<typeof import('@/lib/bot')>()), BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-bayt-')) };
});

const script = join(BOT_ROOT, 'scripts', 'bayt-collect.js');
const PLACEHOLDER = '/*__BAYT_SETTINGS__*/ null';
const get = (url = 'http://localhost:3100/api/bayt-script') => GET(new NextRequest(url));

/** The settings object the route injected into the served script. */
const injected = async (url?: string) => {
  const body = await (await get(url)).text();
  const m = body.match(/const SETTINGS = (\{.*?\});/);
  expect(m, `no injected settings in: ${body}`).toBeTruthy();
  return JSON.parse(m![1]);
};

afterAll(() => rmSync(BOT_ROOT, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

describe('GET /api/bayt-script', () => {
  it('fails when the collector script is missing', async () => {
    await expect(get()).rejects.toThrow(/ENOENT/);
  });

  it('serves the collector as uncached JavaScript with the settings injected', async () => {
    mkdirSync(join(BOT_ROOT, 'scripts'), { recursive: true });
    writeFileSync(script, `const SETTINGS = ${PLACEHOLDER};\nconsole.log("collect bayt");`);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.text();
    expect(body).toContain('console.log("collect bayt");');
    expect(body).not.toContain(PLACEHOLDER);
  });

  it('injects the search settings from config.json, not any hardcoded owner values', async () => {
    // tests/setup.ts points JOB_BOT_CONFIG at a temp copy of config.default.json.
    const defaults = await injected();
    expect(defaults.keywords).toEqual(['laravel', 'php', 'node-js', 'nestjs', 'react', 'next-js', 'full-stack-developer', 'mern']);
    expect(defaults.countries).toEqual(['uae', 'saudi-arabia']); // AE and SA; NL and PK have no Bayt board
    expect(defaults.maxAgeDays).toBe(14);

    // Another user's config.json gives that user's searches.
    const config = join(BOT_ROOT, 'my-config.json');
    writeFileSync(
      config,
      JSON.stringify({
        maxAgeDays: 7,
        linkedin: { keywords: ['Ruby on Rails', 'django!'] },
        countries: { QA: { name: 'Qatar' }, FR: { name: 'France' } },
      }),
    );
    vi.stubEnv('JOB_BOT_CONFIG', config);
    const mine = await injected();
    expect(mine.keywords).toEqual(['ruby-on-rails', 'django']);
    expect(mine.countries).toEqual(['qatar']);
    expect(mine.maxAgeDays).toBe(7);
  });

  it('injects the dashboard origin of the request, so any port works', async () => {
    expect((await injected('http://localhost:4000/api/bayt-script')).dashboard).toBe('http://localhost:4000');
  });

  it('injects the import token from data/import-token and never a token in a URL', async () => {
    const settings = await injected();
    expect(settings.token).toBe(importToken());
    expect(settings.token).toMatch(/^[0-9a-f]{64}$/);
    expect(settings.dashboard).not.toContain(settings.token);
  });

  it('injects empty lists from a missing config.json, leaving the collector on its built-in defaults', async () => {
    vi.stubEnv('JOB_BOT_CONFIG', join(tmpdir(), 'job-bot-no-such-config.json'));
    const settings = await injected();
    expect(settings.keywords).toEqual([]);
    expect(settings.countries).toEqual([]);
    expect(settings.maxAgeDays).toBe(0);
    expect(settings.token).toBe(importToken());
  });

  it('the real collector script carries the placeholder exactly once', () => {
    const real = readFileSync(join(process.cwd(), '..', 'scripts', 'bayt-collect.js'), 'utf8');
    expect(real.split(PLACEHOLDER)).toHaveLength(2);
  });
});
