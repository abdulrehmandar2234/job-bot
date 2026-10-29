import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import type { RawJob } from '../src/sources/index.ts';

// Tests run against their own database (see package.json "test"); refuse anything else so the real job_bot is never touched.
// A suffix (job_bot_test_bot_<name>) lets parallel worktrees use separate databases.
export const TEST_DB = process.env.DATABASE_URL ?? '';
if (!/^postgres:\/\/postgres@127\.0\.0\.1:5432\/job_bot_test_bot(_[a-z0-9]+)?$/.test(TEST_DB)) {
  throw new Error(`Tests must run against job_bot_test_bot (use npm test), not ${TEST_DB}`);
}

// Never show a real macOS notification from a test (ai:score alerts strong matches; see src/notify.ts).
// CLI subprocesses inherit this. Tests of the alerts point JOB_BOT_NOTIFY at tests/fixtures/fake-notify.mjs.
process.env.JOB_BOT_NOTIFY ||= 'off';

// The profile (cv/applicant.json) is personal and gitignored: tests use a fixed copy of the owner's profile, so the
// letters, prompts and filters they check do not depend on whoever runs them. Suites that test other profiles set
// JOB_BOT_APPLICANT themselves (src/profile.ts reads it on every call).
process.env.JOB_BOT_APPLICANT ||= join(import.meta.dirname, 'fixtures', 'applicant-owner.json');

// Never write the real HTTP cache (data/http-cache) from a test. Suites that test the cache set their own dir.
process.env.JOB_BOT_HTTP_CACHE ||= mkdtempSync(join(tmpdir(), 'job-bot-http-cache-'));

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
