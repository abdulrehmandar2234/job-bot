import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPTIONS, POST } from '@/app/api/import/route';
import { BOT_ROOT, runBot } from '@/lib/bot';

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

const post = (body: unknown, origin: string | null = BAYT) => POST(new NextRequest(URL_, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}));

const job = (over: Record<string, unknown> = {}) =>
  ({ company: 'Acme', title: 'Backend Engineer', url: `${BAYT}/en/uae/jobs/backend-123/`, ...over });

/** What `bot add --file` was given. */
const imported = () => {
  const [args] = bot.mock.calls[0];
  return JSON.parse(readFileSync(args[2], 'utf8')) as Record<string, unknown>[];
};

beforeEach(() => {
  vi.clearAllMocks();
  bot.mockResolvedValue('');
});
afterAll(() => rmSync(BOT_ROOT, { recursive: true, force: true }));

describe('OPTIONS (CORS preflight)', () => {
  it.each([BAYT, 'https://www.linkedin.com', 'https://www.gulftalent.com', 'https://www.naukrigulf.com'])(
    'allows %s, including from a public site to localhost', async (origin) => {
      const res = await OPTIONS(new NextRequest(URL_, { method: 'OPTIONS', headers: { origin } }));
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      expect(res.headers.get('access-control-allow-methods')).toBe('POST');
      expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
      expect(res.headers.get('access-control-allow-private-network')).toBe('true');
    });

  it.each(['https://evil.example', 'http://www.bayt.com', null])('does not allow origin %s', async (origin) => {
    const res = await OPTIONS(new NextRequest(URL_, { method: 'OPTIONS', headers: origin ? { origin } : {} }));
    expect(res.headers.get('access-control-allow-origin')).toBe('null');
  });
});

describe('POST', () => {
  it.each([null, 'https://evil.example', 'https://bayt.com', 'http://www.bayt.com'])('rejects origin %s with 403', async (origin) => {
    const res = await post([job()], origin);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('Forbidden origin');
    expect(bot).not.toHaveBeenCalled();
  });

  it.each([['not json', '{oops'], ['an object', { jobs: [] }], ['an empty list', []]])(
    'adds nothing for %s', async (_, body) => {
      const res = await post(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ added: 0 });
      expect(res.headers.get('access-control-allow-origin')).toBe(BAYT);
      expect(bot).not.toHaveBeenCalled();
    });

  it('writes the jobs to an import file, runs `bot add --file` and reports matches', async () => {
    bot.mockResolvedValue('Imported 2\n  81  Acme — Backend Engineer\n  64  Beta — PHP Dev\nfiltered: 0\n');
    const res = await post([job(), job({ company: 'Beta', title: 'PHP Dev', url: `${BAYT}/en/uae/jobs/php-9/` })]);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe(BAYT);
    expect(await res.json()).toEqual({ received: 2, matched: 2, log: expect.stringContaining('Imported 2') });

    expect(bot).toHaveBeenCalledOnce();
    const [args, timeout] = bot.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['add', '--file']);
    expect(args[2].startsWith(join(BOT_ROOT, 'data', 'imports'))).toBe(true);
    expect(args[2]).toMatch(/\.json$/);
    expect(existsSync(args[2])).toBe(true);
    expect(timeout).toBe(120_000);
    expect(imported()).toEqual([
      { source: 'bayt', company: 'Acme', title: 'Backend Engineer', location: '', url: `${BAYT}/en/uae/jobs/backend-123/`, description: '', posted_at: null },
      { source: 'bayt', company: 'Beta', title: 'PHP Dev', location: '', url: `${BAYT}/en/uae/jobs/php-9/`, description: '', posted_at: null },
    ]);
  });

  it('derives the source from the origin unless given', async () => {
    await post([job({ url: 'https://www.linkedin.com/jobs/view/1' }), job({ url: 'https://www.linkedin.com/jobs/view/2', source: 'li-custom' })],
      'https://www.linkedin.com');
    expect(imported().map((j) => j.source)).toEqual(['linkedin', 'li-custom']);
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
    await post([job({
      source: 's'.repeat(50), company: 'c'.repeat(250), title: 't'.repeat(400), location: 'l'.repeat(400),
      description: 'd'.repeat(25_000), posted_at: '2026-10-27',
    })]);
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
    bot.mockResolvedValue('x'.repeat(5000));
    const res = await post([job()]);
    const body = await res.json();
    expect(body.log).toHaveLength(4000);
    expect(body.matched).toBe(0);
  });
});
