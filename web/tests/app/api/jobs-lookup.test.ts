import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET, OPTIONS } from '@/app/api/jobs/lookup/route';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SITE = 'https://careers.lookup-test.example';

const get = (url: string | null, origin: string | null = EXT) => GET(new NextRequest(
  `http://localhost:3100/api/jobs/lookup${url === null ? '' : `?url=${encodeURIComponent(url)}`}`,
  { headers: origin ? { origin } : {} }));

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('GET /api/jobs/lookup', () => {
  it.each([null, 'https://evil.example', 'https://www.bayt.com', 'chrome-extension://nope'])('rejects origin %s with 403', async (origin) => {
    await insertJob({ id: 'a', url: `${SITE}/1`, cover_letter: 'secret' });
    const res = await get(`${SITE}/1`, origin);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden origin' });
  });

  it.each([null, '', 'not a url', 'javascript:alert(1)', 'chrome://extensions'])('rejects url %j with 400', async (url) => {
    const res = await get(url);
    expect(res.status).toBe(400);
  });

  it('returns null for an unknown job', async () => {
    const res = await get(`${SITE}/unknown`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ job: null });
  });

  it('returns the prepared material of an exact match', async () => {
    const answers = [{ question: 'Notice period?', answer: 'One month', needs_input: false, note: '' }];
    await insertJob({ id: 'a', url: `${SITE}/1`, company: 'Acme', title: 'Backend Engineer', status: 'prepared', score: 70,
      ai_score: 82, ai_verdict: 'apply', ai_summary: 'Good fit', cv_version: 'laravel-lead', cover_letter: 'Dear Acme', form_answers: answers });
    const { job } = await (await get(`${SITE}/1`)).json();
    expect(job).toEqual({
      id: `${PREFIX}a`, company: 'Acme', title: 'Backend Engineer', url: `${SITE}/1`, status: 'prepared',
      score: 70, ai_score: 82, ai_verdict: 'apply', ai_summary: 'Good fit', cv_version: 'laravel-lead',
      cv_url: 'http://localhost:3100/api/cv/laravel-lead?download', cover_letter: 'Dear Acme', form_answers: answers,
      dashboard_url: `http://localhost:3100/jobs/${encodeURIComponent(`${PREFIX}a`)}`,
    });
  });

  it('has no CV link before a CV version is chosen', async () => {
    await insertJob({ id: 'a', url: `${SITE}/1` });
    const { job } = await (await get(`${SITE}/1`)).json();
    expect(job).toMatchObject({ cv_version: null, cv_url: null, cover_letter: null, form_answers: [] });
  });

  it('matches without query, hash and trailing slash, and prefers an exact match', async () => {
    await insertJob({ id: 'loose', url: `${SITE}/2?ref=board` });
    expect((await (await get(`${SITE}/2/?utm=x#top`)).json()).job.id).toBe(`${PREFIX}loose`);
    await insertJob({ id: 'exact', url: `${SITE}/2?utm=x` });
    expect((await (await get(`${SITE}/2?utm=x`)).json()).job.id).toBe(`${PREFIX}exact`);
  });

  it('does not match another path that only shares a prefix', async () => {
    await insertJob({ id: 'a', url: `${SITE}/1` });
    expect((await (await get(`${SITE}/12`)).json()).job).toBeNull();
  });

  it('resolves a copy found on another site to its primary job', async () => {
    await insertJob({ id: 'primary', url: `${SITE}/p`, cover_letter: 'Prepared letter' });
    await insertJob({ id: 'copy', url: `${SITE}/copy`, duplicate_of: `${PREFIX}primary` });
    const { job } = await (await get(`${SITE}/copy`)).json();
    expect(job).toMatchObject({ id: `${PREFIX}primary`, cover_letter: 'Prepared letter' });
  });

  it('answers the CORS preflight for the extension only', async () => {
    const ok = await OPTIONS(new NextRequest('http://localhost:3100/api/jobs/lookup', { method: 'OPTIONS', headers: { origin: EXT } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(EXT);
    const bad = await OPTIONS(new NextRequest('http://localhost:3100/api/jobs/lookup', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }));
    expect(bad.headers.get('access-control-allow-origin')).toBe('null');
  });
});
