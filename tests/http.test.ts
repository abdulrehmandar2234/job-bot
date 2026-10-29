import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch } from './helpers.ts';
import { HttpError, UA, getJson, getText, postJson, request, retryDelay, timing } from '../src/sources/http.ts';

const cacheDir = mkdtempSync(join(tmpdir(), 'job-bot-http-'));
before(() => {
  timing.scale = 0;
  process.env.JOB_BOT_HTTP_CACHE = cacheDir;
});
after(() => rmSync(cacheDir, { recursive: true, force: true }));
let net: ReturnType<typeof mockFetch>;
afterEach(() => net?.restore());

const status = (code: number, headers: Record<string, string> = {}) => new Response(null, { status: code, headers });

/** Runs fn with real-scale sleeps that resolve at once, and returns the delays that were asked for. */
async function recordSleeps(fn: () => Promise<unknown>) {
  const delays: number[] = [];
  timing.scale = 1;
  const t = mock.method(globalThis, 'setTimeout', ((cb: () => void, ms: number) => {
    delays.push(ms);
    cb();
    return 0;
  }) as any);
  try {
    await fn();
  } finally {
    t.mock.restore();
    timing.scale = 0;
  }
  return delays;
}

describe('request: retries', () => {
  it('retries 5xx, 429 and network errors, then returns the body', async () => {
    let n = 0;
    net = mockFetch({
      'a.test': () => {
        n++;
        if (n === 1) throw new TypeError('fetch failed');
        if (n === 2) return status(503);
        if (n === 3) return status(429);
        return { ok: true };
      },
    });
    assert.deepEqual(await getJson('https://a.test/x', { cache: false }), { ok: true });
    assert.equal(n, 4);
  });

  it('backs off exponentially with jitter', async () => {
    assert.equal(
      retryDelay(0, 1000, null, () => 0.5),
      1000,
    );
    assert.equal(
      retryDelay(1, 1000, null, () => 0.5),
      2000,
    );
    assert.equal(
      retryDelay(2, 1000, null, () => 0.5),
      4000,
    );
    assert.equal(
      retryDelay(2, 1000, null, () => 0),
      2000,
    );
    assert.equal(
      retryDelay(2, 1000, null, () => 0.999),
      5996,
    );
    net = mockFetch({ 'b.test': () => status(500) });
    const delays = await recordSleeps(() => request('https://b.test/', { cache: false, attempts: 3 }).catch(() => {}));
    assert.equal(delays.length, 2);
    assert.ok(delays[0] >= 500 && delays[0] <= 1500, `first delay ${delays[0]}`);
    assert.ok(delays[1] >= 1000 && delays[1] <= 3000, `second delay ${delays[1]}`);
  });

  it('waits as long as Retry-After says (seconds or an HTTP date)', async () => {
    assert.equal(retryDelay(0, 1000, '7'), 7000);
    const at = new Date(Date.now() + 30_000).toUTCString();
    assert.ok(Math.abs(retryDelay(0, 1000, at) - 30_000) < 2000);
    let n = 0;
    net = mockFetch({ 'c.test': () => (++n === 1 ? status(429, { 'retry-after': '5' }) : 'ok') });
    const delays = await recordSleeps(() => getText('https://c.test/', { cache: false }));
    assert.deepEqual(delays, [5000]);
  });

  it('gives up at once when Retry-After is too long', async () => {
    net = mockFetch({ 'd.test': () => status(429, { 'retry-after': '3600' }) });
    await assert.rejects(getText('https://d.test/', { cache: false }), /429 d\.test asked to retry after 3600s/);
    assert.equal(net.calls.length, 1);
  });

  it('gives up after the last attempt with an error that names the host', async () => {
    net = mockFetch({ 'e.test': () => status(502) });
    await assert.rejects(
      getText('https://e.test/jobs', { cache: false, attempts: 3 }),
      /^Error: e\.test: gave up after 3 attempts \(last: 502\) https:\/\/e\.test\/jobs$/,
    );
    assert.equal(net.calls.length, 3);
  });

  it('does not retry a 404 and throws an HttpError with the status', async () => {
    net = mockFetch({});
    const err = await getText('https://f.test/missing', { cache: false }).catch((e) => e);
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 404);
    assert.match(err.message, /^404 https:\/\/f\.test\/missing$/);
    assert.equal(net.calls.length, 1);
  });

  it('sends the job-bot User-Agent unless the caller sets one', async () => {
    const agents: (string | undefined)[] = [];
    net = mockFetch({
      'g.test': (_u: string, init?: RequestInit) => {
        agents.push((init?.headers as Record<string, string> | undefined)?.['user-agent']);
        return 'ok';
      },
    });
    await getText('https://g.test/', { cache: false });
    await getText('https://g.test/', { cache: false, headers: { 'User-Agent': 'Browser' } });
    assert.deepEqual(agents, [UA, 'Browser']);
  });
});

describe('request: conditional cache', () => {
  it('stores ETag/Last-Modified and reuses the cached body on 304', async () => {
    const seen: Record<string, string>[] = [];
    net = mockFetch({
      'h.test': (_u: string, init?: RequestInit) => {
        const h = init?.headers as Record<string, string>;
        seen.push(h);
        return h['if-none-match'] === '"v1"'
          ? status(304)
          : new Response('{"jobs":[1,2]}', { headers: { etag: '"v1"', 'last-modified': 'Tue, 27 Oct 2026 10:00:00 GMT' } });
      },
    });
    const first = await request('https://h.test/jobs');
    const second = await request('https://h.test/jobs');
    assert.deepEqual([first.status, first.fromCache], [200, false]);
    assert.deepEqual([second.status, second.fromCache, second.body], [304, true, '{"jobs":[1,2]}']);
    assert.equal(seen[0]['if-none-match'], undefined);
    assert.equal(seen[1]['if-modified-since'], 'Tue, 27 Oct 2026 10:00:00 GMT');
    assert.deepEqual(await getJson('https://h.test/jobs'), { jobs: [1, 2] });
    assert.ok(readdirSync(cacheDir).some((f) => f.endsWith('.json')));
  });

  it('does not cache responses without validators, nor when cache is off', async () => {
    const seen: Record<string, string>[] = [];
    net = mockFetch({
      'i.test': (_u: string, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return new Response('x', { headers: seen.length === 1 ? {} : { etag: '"e"' } });
      },
    });
    await getText('https://i.test/a');
    await getText('https://i.test/a');
    await getText('https://i.test/b', { cache: false });
    await getText('https://i.test/b', { cache: false });
    assert.ok(seen.every((h) => !h['if-none-match']));
  });
});

describe('request: POST', () => {
  it('sends a JSON body, retries 5xx and never uses the cache', async () => {
    const seen: RequestInit[] = [];
    const cachedBefore = readdirSync(cacheDir).length;
    net = mockFetch({
      'j.test': (_u: string, init?: RequestInit) => {
        seen.push(init!);
        return seen.length === 1 ? status(503) : new Response('{"total":1}', { headers: { etag: '"p"' } });
      },
    });
    assert.deepEqual(await postJson('https://j.test/search', { limit: 20 }), { total: 1 });
    assert.deepEqual(await postJson('https://j.test/search', { limit: 20 }), { total: 1 });
    assert.equal(seen.length, 3);
    assert.equal(readdirSync(cacheDir).length, cachedBefore);
    for (const init of seen) {
      const h = init.headers as Record<string, string>;
      assert.equal(init.method, 'POST');
      assert.equal(init.body, '{"limit":20}');
      assert.equal(h['content-type'], 'application/json');
      assert.equal(h['user-agent'], UA);
      assert.equal(h['if-none-match'], undefined);
    }
  });

  it('does not retry a 4xx POST', async () => {
    net = mockFetch({});
    await assert.rejects(postJson('https://k.test/search', {}), (e) => e instanceof HttpError && e.status === 404);
    assert.equal(net.calls.length, 1);
  });

  it('GET stays the default and sends no body', async () => {
    let init: RequestInit | undefined;
    net = mockFetch({
      'l.test': (_u: string, i?: RequestInit) => {
        init = i;
        return 'ok';
      },
    });
    await getText('https://l.test/', { cache: false });
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
  });
});
