import { mock } from 'node:test';
import type { RawJob } from '../src/sources/index.ts';

// Tests run against their own database (see package.json "test"); refuse anything else so the real job_bot is never touched.
// A suffix (job_bot_test_bot_<name>) lets parallel worktrees use separate databases.
export const TEST_DB = process.env.DATABASE_URL ?? '';
if (!/^postgres:\/\/postgres@127\.0\.0\.1:5432\/job_bot_test_bot(_[a-z0-9]+)?$/.test(TEST_DB)) {
  throw new Error(`Tests must run against job_bot_test_bot (use npm test), not ${TEST_DB}`);
}

export const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export const raw = (o: Partial<RawJob> = {}): RawJob => ({
  id: 'test:1',
  source: 'greenhouse',
  company: 'Acme',
  title: 'Senior Full Stack Engineer',
  location: 'Dubai, UAE',
  url: 'https://example.com/jobs/1',
  description: 'We use Laravel, PHP, React, Node.js, TypeScript and PostgreSQL to build REST APIs.',
  posted_at: daysAgo(2),
  ...o,
});

type Route = (url: string, init?: RequestInit) => unknown;

/** Replaces global fetch: each route maps a URL substring to a JSON body, a string (text body) or a Response. */
export function mockFetch(routes: Record<string, Route | unknown>) {
  const calls: string[] = [];
  const fn = mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key];
    const body = typeof r === 'function' ? (r as Route)(url, init) : r;
    if (body instanceof Response) return body;
    return typeof body === 'string' ? new Response(body) : Response.json(body);
  });
  return { calls, restore: () => fn.mock.restore() };
}
