import { createHash } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIONS, POST } from '@/app/api/import/route';
import { BOT_ROOT, runBot } from '@/lib/bot';
import { EXTENSION_ID, importToken } from '@/lib/extension';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

// Never spawn the bot; import files go to a temp "bot root". `bot add` is played by insertJob below.
vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/bot')>()),
    BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-import-ext-')),
    runBot: vi.fn(),
  };
});

const bot = vi.mocked(runBot);
const EXT = `chrome-extension://${EXTENSION_ID}`;
const OTHER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SITE = 'https://careers.extension-test.example';

const post = (body: unknown, origin: string | null = EXT) =>
  POST(
    new NextRequest('http://localhost:3100/api/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
      body: JSON.stringify(body),
    }),
  );

const job = (over: Record<string, unknown> = {}) => ({
  source: 'extension',
  company: 'Acme',
  title: 'Backend Engineer',
  location: 'Dubai',
  url: `${SITE}/jobs/1`,
  ...over,
});

type Imported = { source: string; company: string; title: string; url: string; posted_at: string | null };
// The import file is deleted after a successful `bot add`, so fakeAdd captures what it was given.
let sent: Imported[][] = [];
const imported = () => sent[0];

/** Plays `bot add`: saves each imported job, filtered when its title says so. */
const fakeAdd = async (args: string[]) => {
  const jobs = JSON.parse(readFileSync(args[2], 'utf8')) as Imported[];
  sent.push(jobs);
  for (const [i, j] of jobs.entries()) {
    const filtered = /filtered/.test(j.title);
    await insertJob({
      id: `ext-${Date.now()}-${i}`,
      source: j.source,
      company: j.company,
      title: j.title,
      url: j.url,
      score: filtered ? 0 : 72,
      status: filtered ? 'filtered' : 'new',
      filter_reason: filtered ? 'location not in target countries (Mars)' : null,
    });
  }
  return `  72  ${jobs[0]?.company} — ${jobs[0]?.title}\n`;
};

beforeAll(ensureSchema);
beforeEach(async () => {
  vi.clearAllMocks();
  sent = [];
  bot.mockImplementation(fakeAdd);
  await cleanupDb();
});
afterAll(async () => {
  rmSync(BOT_ROOT, { recursive: true, force: true });
  await closeDb();
});

describe('POST /api/import from the Chrome extension', () => {
  it('allows only the pinned extension in the CORS preflight', async () => {
    const preflight = (origin: string) =>
      OPTIONS(new NextRequest('http://localhost:3100/api/import', { method: 'OPTIONS', headers: { origin } }));
    expect((await preflight(EXT)).headers.get('access-control-allow-origin')).toBe(EXT);
    expect((await preflight(OTHER)).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('needs no import token: the chrome-extension:// origin cannot be forged by web pages', async () => {
    // Every post() in this file sends no x-import-token header; this one just says so explicitly.
    expect((await post([job()])).status).toBe(200);
  });

  it('accepts another id set in JOB_BOT_EXTENSION_ID instead of the pinned one', async () => {
    vi.stubEnv('JOB_BOT_EXTENSION_ID', 'abcdefghijklmnopabcdefghijklmnop');
    try {
      expect((await post([job()], OTHER)).status).toBe(200);
      expect((await post([job({ url: `${SITE}/jobs/2` })], EXT)).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('ignores a JOB_BOT_EXTENSION_ID that is not an extension id', async () => {
    vi.stubEnv('JOB_BOT_EXTENSION_ID', '*');
    try {
      expect((await post([job()], 'chrome-extension://*')).status).toBe(403);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('pins the id that the public key in extension/manifest.json produces', () => {
    const { key } = JSON.parse(readFileSync(join(process.cwd(), '..', 'extension', 'manifest.json'), 'utf8'));
    const hex = createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
    expect([...hex].map((h) => String.fromCharCode(97 + parseInt(h, 16))).join('')).toBe(EXTENSION_ID);
  });

  it.each([OTHER, 'chrome-extension://short', `moz-extension://${EXTENSION_ID}`, `${EXT}x`, 'https://evil.example'])(
    'rejects origin %s',
    async (origin) => {
      const res = await post([job()], origin);
      expect(res.status).toBe(403);
      expect(bot).not.toHaveBeenCalled();
    },
  );

  it('adds a job from any http(s) site and reports its score', async () => {
    const res = await post([job()]);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT);
    const body = await res.json();
    expect(body).toMatchObject({ received: 1, matched: 1 });
    expect(body.results).toEqual([
      {
        url: `${SITE}/jobs/1`,
        outcome: 'added',
        id: expect.stringMatching(new RegExp(`^${PREFIX}ext-`)),
        status: 'new',
        score: 72,
        ai_score: null,
        filter_reason: null,
      },
    ]);
    expect(imported()).toEqual([
      {
        source: 'extension',
        company: 'Acme',
        title: 'Backend Engineer',
        location: 'Dubai',
        url: `${SITE}/jobs/1`,
        description: '',
        posted_at: null,
      },
    ]);
  });

  it('reports a filtered job with the reason', async () => {
    const [r] = (await (await post([job({ title: 'filtered role' })])).json()).results;
    expect(r).toMatchObject({ outcome: 'filtered', status: 'filtered', filter_reason: 'location not in target countries (Mars)' });
  });

  it('does not re-add a known job, also when only the query or hash differ', async () => {
    const id = await insertJob({ id: 'known', url: `${SITE}/jobs/7`, status: 'applied', score: 81, ai_score: 77 });
    const body = await (await post([job({ url: `${SITE}/jobs/7?utm_source=x#apply` })])).json();
    expect(bot).not.toHaveBeenCalled();
    expect(body.results).toEqual([
      { url: `${SITE}/jobs/7?utm_source=x#apply`, outcome: 'known', id, status: 'applied', score: 81, ai_score: 77, filter_reason: null },
    ]);
  });

  it('adds only the unknown jobs of a mixed request and keeps the order', async () => {
    await insertJob({ id: 'known', url: `${SITE}/jobs/7` });
    const body = await (await post([job({ url: `${SITE}/jobs/8` }), job({ url: `${SITE}/jobs/7` })])).json();
    expect(imported().map((j) => j.url)).toEqual([`${SITE}/jobs/8`]);
    expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['added', 'known']);
  });

  it('keeps a slug source, else uses "extension"', async () => {
    await post([
      job({ url: `${SITE}/a`, source: 'gulftalent' }),
      job({ url: `${SITE}/b`, source: 'Bad Source!' }),
      job({ url: `${SITE}/c`, source: undefined }),
    ]);
    expect(imported().map((j) => j.source)).toEqual(['gulftalent', 'extension', 'extension']);
  });

  it('drops non-http(s) urls and jobs without title or company', async () => {
    const res = await post([
      job({ url: 'javascript:alert(1)' }),
      job({ url: 'file:///etc/passwd' }),
      job({ url: '/relative' }),
      job({ title: undefined }),
      job({ company: 3 }),
    ]);
    expect(await res.json()).toEqual({ added: 0, results: [] });
    expect(bot).not.toHaveBeenCalled();
  });

  it('reports an error when the bot did not save the job', async () => {
    bot.mockResolvedValue('');
    const [r] = (await (await post([job({ url: `${SITE}/lost` })])).json()).results;
    expect(r).toEqual({ url: `${SITE}/lost`, outcome: 'error' });
  });

  it('answers a failed `bot add` with a JSON error the popup can show, and the extension CORS header', async () => {
    bot.mockRejectedValue(Object.assign(new Error('Command failed'), { stderr: 'error: connection refused\n' }));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post([job({ url: `${SITE}/boom` })]);
    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT);
    expect(await res.json()).toEqual({ error: 'Import failed: error: connection refused' });
    error.mockRestore();
  });

  it('sends posted_at as a date or null, never a value Postgres rejects', async () => {
    await post([job({ url: `${SITE}/d1`, posted_at: '2026-10-20T10:00:00+04:00' }), job({ url: `${SITE}/d2`, posted_at: 'Yesterday' })]);
    expect(imported().map((j) => j.posted_at)).toEqual(['2026-10-20', null]);
  });

  it('still limits Bayt bookmarklet requests to bayt.com urls', async () => {
    const res = await POST(
      new NextRequest('http://localhost:3100/api/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://www.bayt.com', 'x-import-token': importToken() },
        body: JSON.stringify([job({ url: `${SITE}/jobs/1` })]),
      }),
    );
    expect(await res.json()).toEqual({ added: 0 });
  });
});
