import { existsSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET, OPTIONS } from '@/app/api/jobs/lookup/route';
import { cvFileName, cvPath } from '@/lib/cv-templates';
import { EXTENSION_ID, fillProfile } from '@/lib/extension';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

const EXT = `chrome-extension://${EXTENSION_ID}`;
const SITE = 'https://careers.lookup-test.example';

const get = (url: string | null, origin: string | null = EXT) =>
  GET(
    new NextRequest(`http://localhost:3100/api/jobs/lookup${url === null ? '' : `?url=${encodeURIComponent(url)}`}`, {
      headers: origin ? { origin } : {},
    }),
  );

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('GET /api/jobs/lookup', () => {
  it.each([
    null,
    'https://evil.example',
    'https://www.bayt.com',
    'chrome-extension://nope',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  ])('rejects origin %s with 403', async (origin) => {
    await insertJob({ id: 'a', url: `${SITE}/1`, cover_letter: 'secret' });
    const res = await get(`${SITE}/1`, origin);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ app: 'job-bot', error: 'Forbidden origin' });
  });

  it.each([null, '', 'not a url', 'javascript:alert(1)', 'chrome://extensions'])('rejects url %j with 400', async (url) => {
    const res = await get(url);
    expect(res.status).toBe(400);
    expect((await res.json()).app).toBe('job-bot');
  });

  it('returns null for an unknown job', async () => {
    const res = await get(`${SITE}/unknown`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // The profile and the original CV, for "Fill profile + CV only" on a page with no known job.
    expect(await res.json()).toEqual({
      app: 'job-bot',
      job: null,
      basics: {
        profile: fillProfile(),
        cv_url: existsSync(cvPath('default')) ? 'http://localhost:3100/api/cv/default?download' : null,
        cv_file_name: cvFileName(),
      },
    });
  });

  it('marks every answer as job-bot, with or without a job', async () => {
    await insertJob({ id: 'a', url: `${SITE}/1` });
    expect((await (await get(`${SITE}/1`)).json()).app).toBe('job-bot');
  });

  it.each([
    ['Lever', 'https://jobs.lever.co/acme/5f1c-9a', 'https://jobs.lever.co/acme/5f1c-9a/apply'],
    ['Lever (trailing slash, tracking)', 'https://jobs.lever.co/acme/5f1c-9a', 'https://jobs.lever.co/acme/5f1c-9a/apply/?lever-source=li'],
    ['Ashby', 'https://jobs.ashbyhq.com/acme/7c2e-41', 'https://jobs.ashbyhq.com/acme/7c2e-41/application'],
    ['Greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/123', 'https://job-boards.greenhouse.io/acme/jobs/123#app'],
    [
      'Workday apply',
      'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Engineer_R123',
      'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Engineer_R123/apply',
    ],
    [
      'Workday apply step',
      'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Engineer_R123',
      'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Engineer_R123/apply/applyManually',
    ],
  ])('finds the job from its %s application page', async (_name, posting, form) => {
    await insertJob({ id: 'a', url: posting, cover_letter: 'Prepared letter' });
    expect((await (await get(form)).json()).job).toMatchObject({ id: `${PREFIX}a`, cover_letter: 'Prepared letter' });
  });

  it('does not take an apply suffix off unrelated paths or hosts', async () => {
    await insertJob({ id: 'lever', url: 'https://jobs.lever.co/acme/1' });
    await insertJob({ id: 'site', url: `${SITE}/jobs/1` });
    await insertJob({ id: 'ashby', url: 'https://jobs.ashbyhq.com/acme/2' });
    const lookup = async (url: string) => (await (await get(url)).json()).job;
    expect(await lookup('https://jobs.lever.co/acme/1/apply/thanks')).toBeNull();
    expect(await lookup('https://jobs.lever.co/acme/1/applyx')).toBeNull();
    expect(await lookup(`${SITE}/jobs/1/apply`)).toBeNull(); // not a known ATS host
    expect(await lookup('https://jobs.ashbyhq.com/acme/2/apply')).toBeNull(); // Ashby's form is /application
    expect(await lookup('https://jobs.lever.co/acme/2/apply')).toBeNull(); // another job
  });

  it('keeps the job id parameter rule when it strips an apply suffix', async () => {
    await insertJob({ id: 'one', url: 'https://acme.wd1.myworkdayjobs.com/c/job/x?jobId=1' });
    await insertJob({ id: 'two', url: 'https://acme.wd1.myworkdayjobs.com/c/job/x?jobId=2' });
    const lookup = async (url: string) => (await (await get(url)).json()).job;
    expect((await lookup('https://acme.wd1.myworkdayjobs.com/c/job/x/apply?jobId=2&utm=1')).id).toBe(`${PREFIX}two`);
    expect(await lookup('https://acme.wd1.myworkdayjobs.com/c/job/x/apply?jobId=3')).toBeNull();
  });

  it('returns the prepared material of an exact match', async () => {
    const answers = [{ question: 'Notice period?', answer: 'One month', needs_input: false, note: '' }];
    await insertJob({
      id: 'a',
      url: `${SITE}/1`,
      company: 'Acme',
      title: 'Backend Engineer',
      status: 'prepared',
      score: 70,
      ai_score: 82,
      ai_verdict: 'apply',
      ai_summary: 'Good fit',
      cv_version: 'laravel-lead',
      cover_letter: 'Dear Acme',
      form_answers: answers,
    });
    const { job } = await (await get(`${SITE}/1`)).json();
    expect(job).toEqual({
      id: `${PREFIX}a`,
      company: 'Acme',
      title: 'Backend Engineer',
      url: `${SITE}/1`,
      status: 'prepared',
      score: 70,
      ai_score: 82,
      ai_verdict: 'apply',
      ai_summary: 'Good fit',
      cv_version: 'laravel-lead',
      cv_url: 'http://localhost:3100/api/cv/laravel-lead?download',
      cv_file_name: cvFileName(),
      cover_letter: 'Dear Acme',
      form_answers: answers,
      dashboard_url: `http://localhost:3100/jobs/${encodeURIComponent(`${PREFIX}a`)}`,
      profile: fillProfile(),
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

  it('tells jobs apart that share a path and differ in a job id parameter (Greenhouse embed)', async () => {
    await insertJob({ id: 'one', url: 'https://acme.com/careers?gh_jid=1', cover_letter: 'Letter for job 1' });
    await insertJob({ id: 'two', url: 'https://acme.com/careers?gh_jid=2', cover_letter: 'Letter for job 2' });
    const lookup = async (url: string) => (await (await get(url)).json()).job;
    expect(await lookup('https://acme.com/careers?gh_jid=1')).toMatchObject({ id: `${PREFIX}one`, cover_letter: 'Letter for job 1' });
    expect(await lookup('https://acme.com/careers?gh_jid=2')).toMatchObject({ id: `${PREFIX}two`, cover_letter: 'Letter for job 2' });
    // Tracking parameters, hash and trailing slash are still ignored.
    expect((await lookup('https://acme.com/careers/?gh_jid=1&utm_source=li#app')).id).toBe(`${PREFIX}one`);
    expect((await lookup('https://acme.com/careers?utm_source=li&gh_jid=2')).id).toBe(`${PREFIX}two`);
    // Neither the listing page nor a third job is either of them.
    expect(await lookup('https://acme.com/careers')).toBeNull();
    expect(await lookup('https://acme.com/careers?gh_jid=3')).toBeNull();
  });

  it('still matches a plain path loosely when only tracking parameters differ', async () => {
    await insertJob({ id: 'a', url: `${SITE}/jobs/9?utm_source=board&ref=x` });
    expect((await (await get(`${SITE}/jobs/9/?trk=li#apply`)).json()).job.id).toBe(`${PREFIX}a`);
  });

  it('answers null rather than guess between jobs that only differ in an unknown parameter', async () => {
    await insertJob({ id: 'a', url: `${SITE}/apply?posting=1` });
    await insertJob({ id: 'b', url: `${SITE}/apply?posting=2` });
    expect((await (await get(`${SITE}/apply?posting=3`)).json()).job).toBeNull();
    // An exact match is still found.
    expect((await (await get(`${SITE}/apply?posting=2`)).json()).job.id).toBe(`${PREFIX}b`);
  });

  it('matches loosely when the matching rows are one job and its copy', async () => {
    await insertJob({ id: 'primary', url: `${SITE}/3?ref=a`, cover_letter: 'Prepared letter' });
    await insertJob({ id: 'copy', url: `${SITE}/3?ref=b`, duplicate_of: `${PREFIX}primary` });
    expect((await (await get(`${SITE}/3?ref=c`)).json()).job).toMatchObject({ id: `${PREFIX}primary`, cover_letter: 'Prepared letter' });
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
    const bad = await OPTIONS(
      new NextRequest('http://localhost:3100/api/jobs/lookup', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    );
    expect(bad.headers.get('access-control-allow-origin')).toBe('null');
  });
});
