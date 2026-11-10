import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIONS, POST } from '@/app/api/import/route';
import { BOT_ROOT, botDataDir, runBot } from '@/lib/bot';
import { importToken } from '@/lib/extension';

// Never spawn the bot; import files go to a temp "bot root".
vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/bot')>()),
    BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-import-')),
    runBot: vi.fn(),
  };
});

const bot = vi.mocked(runBot);
const BAYT = 'https://www.bayt.com';
const URL_ = 'http://localhost:3100/api/import';
// The data folder is a temp one for every test run (web/tests/setup.ts, JOB_BOT_DATA_DIR).
const IMPORTS = join(botDataDir(), 'imports');

// The web-origin path requires the import token; `token: null` leaves the header out, any other string is sent as is.
const post = (body: unknown, origin: string | null = BAYT, token: string | null = importToken()) =>
  POST(
    new NextRequest(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(token ? { 'x-import-token': token } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

const job = (over: Record<string, unknown> = {}) => ({
  company: 'Acme',
  title: 'Backend Engineer',
  url: `${BAYT}/en/uae/jobs/backend-123/`,
  ...over,
});

// The import file is deleted after a successful `bot add`, so its content is captured while the bot "runs".
let sent: Record<string, unknown>[][] = [];
let botOut = '';

/** What `bot add --file` was given. */
const imported = () => sent[0];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  botOut = '';
  bot.mockImplementation(async (args) => {
    sent.push(JSON.parse(readFileSync(args[2], 'utf8')) as Record<string, unknown>[]);
    return botOut;
  });
});
afterAll(() => rmSync(BOT_ROOT, { recursive: true, force: true }));

describe('OPTIONS (CORS preflight)', () => {
  it.each([BAYT, 'https://www.linkedin.com', 'https://www.gulftalent.com', 'https://www.naukrigulf.com'])(
    'allows %s, including from a public site to localhost',
    async (origin) => {
      const res = await OPTIONS(new NextRequest(URL_, { method: 'OPTIONS', headers: { origin } }));
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-allow-methods')).toBe('POST');
      expect(res.headers.get('access-control-allow-headers')).toBe('content-type, x-import-token');
      expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    },
  );

  // No header at all (not the literal "null", which would match sandboxed iframes whose origin serializes to "null").
  it.each(['https://evil.example', 'http://www.bayt.com', null])('sends no allow-origin header for origin %s', async (origin) => {
    const res = await OPTIONS(new NextRequest(URL_, { method: 'OPTIONS', headers: origin ? { origin } : {} }));
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('POST', () => {
  it.each([null, 'https://evil.example', 'https://bayt.com', 'http://www.bayt.com'])('rejects origin %s with 403', async (origin) => {
    const res = await post([job()], origin);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden origin');
    expect(bot).not.toHaveBeenCalled();
  });

  it.each([
    ['not json', '{oops'],
    ['an object', { jobs: [] }],
    ['an empty list', []],
  ])('adds nothing for %s', async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ added: 0 });
    expect(res.headers.get('access-control-allow-origin')).toBe(BAYT);
    expect(bot).not.toHaveBeenCalled();
  });

  it('writes the jobs to an import file, runs `bot add --file` and reports matches', async () => {
    botOut = 'Imported 2\n  81  Acme — Backend Engineer\n  64  Beta — PHP Dev\nfiltered: 0\n';
    const res = await post([job(), job({ company: 'Beta', title: 'PHP Dev', url: `${BAYT}/en/uae/jobs/php-9/` })]);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe(BAYT);
    expect(await res.json()).toEqual({ received: 2, matched: 2, log: expect.stringContaining('Imported 2') });

    expect(bot).toHaveBeenCalledOnce();
    const [args, timeout] = bot.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['add', '--file']);
    expect(args[2].startsWith(IMPORTS)).toBe(true);
    expect(args[2].startsWith(join(process.env.JOB_BOT_DATA_DIR!, 'imports'))).toBe(true);
    expect(args[2]).toMatch(/\.json$/);
    expect(existsSync(args[2])).toBe(false); // deleted once `bot add` succeeded
    expect(timeout).toBe(120_000);
    expect(imported()).toEqual([
      {
        source: 'bayt',
        company: 'Acme',
        title: 'Backend Engineer',
        location: '',
        url: `${BAYT}/en/uae/jobs/backend-123/`,
        description: '',
        posted_at: null,
      },
      {
        source: 'bayt',
        company: 'Beta',
        title: 'PHP Dev',
        location: '',
        url: `${BAYT}/en/uae/jobs/php-9/`,
        description: '',
        posted_at: null,
      },
    ]);
  });

  it('derives the source from the origin unless a valid slug is given', async () => {
    await post(
      [
        job({ url: 'https://www.linkedin.com/jobs/view/1' }),
        job({ url: 'https://www.linkedin.com/jobs/view/2', source: 'li-custom' }),
        job({ url: 'https://www.linkedin.com/jobs/view/3', source: 'Not A Slug' }),
        job({ url: 'https://www.linkedin.com/jobs/view/4', source: '../../etc' }),
        job({ url: 'https://www.linkedin.com/jobs/view/5', source: 's'.repeat(31) }),
        job({ url: 'https://www.linkedin.com/jobs/view/6', source: 42 }),
        job({ url: 'https://www.linkedin.com/jobs/view/7', source: '' }),
      ],
      'https://www.linkedin.com',
    );
    expect(imported().map((j) => j.source)).toEqual(['linkedin', 'li-custom', 'linkedin', 'linkedin', 'linkedin', 'linkedin', 'linkedin']);
  });

  it('keeps posted_at only as a real YYYY-MM-DD date, so one bad value cannot fail the batch', async () => {
    const dates = [
      '2026-10-27',
      '2026-10-27T08:15:00Z',
      '3 days ago',
      '27/10/2026',
      '2026-02-30',
      '2026-13-01',
      '',
      20261027,
      null,
      undefined,
    ];
    await post(dates.map((posted_at, i) => job({ url: `${BAYT}/job/d${i}`, posted_at })));
    expect(imported().map((j) => j.posted_at)).toEqual(['2026-10-27', '2026-10-27', null, null, null, null, null, null, null, null]);
  });

  it('answers a failed `bot add` with a JSON error and the CORS headers', async () => {
    bot.mockRejectedValue(
      Object.assign(new Error('Command failed: node src/cli.ts add --file /Users/x/job-bot/data/imports/a.json\nstack…'), {
        stderr: 'Loading jobs…\nerror: invalid input syntax for type date: "yesterday"\n',
      }),
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post([job()]);

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe(BAYT);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    expect(await res.json()).toEqual({ error: 'Import failed: error: invalid input syntax for type date: "yesterday"' });
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('falls back to the first line of the error message when the bot wrote no stderr', async () => {
    bot.mockRejectedValue(new Error('spawn ENOENT\nmore'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post([job()]);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Import failed: spawn ENOENT' });
    vi.mocked(console.error).mockRestore();
  });

  it('drops jobs whose url is not on the posting site, or that miss required fields', async () => {
    await post([
      job({ title: 'kept' }),
      job({ title: 'other site', url: 'https://evil.example/job' }),
      job({ title: 'lookalike host', url: 'https://www.bayt.com.evil.example/job' }),
      job({ title: 'userinfo trick', url: 'https://www.bayt.com@evil.example/job' }),
      job({ title: 'relative', url: '/en/jobs/1' }),
      job({ title: 'no url', url: undefined }),
      job({ company: undefined }),
      job({ title: 42 }),
      null,
      'a string',
    ]);
    expect(imported().map((j) => j.title)).toEqual(['kept']);
  });

  it('caps field lengths and keeps location, description and posted_at', async () => {
    await post([
      job({
        source: 's'.repeat(30),
        company: 'c'.repeat(250),
        title: 't'.repeat(400),
        location: 'l'.repeat(400),
        description: 'd'.repeat(25_000),
        posted_at: '2026-10-27',
      }),
    ]);
    const [j] = imported();
    expect((j.source as string).length).toBe(30);
    expect((j.company as string).length).toBe(200);
    expect((j.title as string).length).toBe(300);
    expect((j.location as string).length).toBe(300);
    expect((j.description as string).length).toBe(20_000);
    expect(j.posted_at).toBe('2026-10-27');
  });

  it('takes at most 500 jobs per request', async () => {
    const res = await post(Array.from({ length: 520 }, (_, i) => job({ url: `${BAYT}/job/${i}` })));
    expect((await res.json()).received).toBe(500);
    expect(imported()).toHaveLength(500);
  });

  it('truncates the bot log to 4000 characters', async () => {
    botOut = 'x'.repeat(5000);
    const res = await post([job()]);
    const body = await res.json();
    expect(body.log).toHaveLength(4000);
    expect(body.matched).toBe(0);
  });
});

describe('import token (web origins only)', () => {
  it.each([
    ['without a token', null],
    ['with a wrong token', 'f'.repeat(64)],
    ['with a truncated token', importToken().slice(0, 63)],
  ])('rejects a POST from an allowed web origin %s', async (_, token) => {
    const res = await post([job()], BAYT, token);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: expect.stringContaining('import token') });
    // The CORS headers are still there, so the collector can read and show the error.
    expect(res.headers.get('access-control-allow-origin')).toBe(BAYT);
    expect(bot).not.toHaveBeenCalled();
  });

  it('accepts a POST with the token (the default of post())', async () => {
    expect((await post([job()])).status).toBe(200);
    expect(bot).toHaveBeenCalledOnce();
  });

  it('never puts the token in the import file or the response', async () => {
    botOut = 'ok';
    const res = await post([job()]);
    expect(JSON.stringify(imported())).not.toContain(importToken());
    expect(JSON.stringify(await res.json())).not.toContain(importToken());
  });
});

describe('import files under data/imports', () => {
  beforeEach(() => rmSync(IMPORTS, { recursive: true, force: true }));

  it('keeps the import file when `bot add` fails, for debugging', async () => {
    bot.mockRejectedValue(Object.assign(new Error('boom'), { stderr: 'error: db down\n' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await post([job()])).status).toBe(500);
    vi.mocked(console.error).mockRestore();
    expect(readdirSync(IMPORTS)).toHaveLength(1);
  });

  it('prunes import files older than 14 days on the next import, and keeps younger ones', async () => {
    mkdirSync(IMPORTS, { recursive: true });
    const stale = join(IMPORTS, 'stale.json');
    writeFileSync(stale, '[]');
    const old = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(stale, old, old);
    writeFileSync(join(IMPORTS, 'kept-failed-import.json'), '[]'); // a fresh leftover of a failed run
    writeFileSync(join(IMPORTS, 'notes.txt'), 'not an import file');

    expect((await post([job()])).status).toBe(200);
    // The stale file is pruned, the fresh leftover and the non-JSON file stay, the new file was deleted on success.
    expect(readdirSync(IMPORTS).sort()).toEqual(['kept-failed-import.json', 'notes.txt']);
  });
});
