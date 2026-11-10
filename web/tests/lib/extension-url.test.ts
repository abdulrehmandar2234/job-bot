import { describe, expect, it } from 'vitest';
import {
  APPLY_STEPS as EXT_STEPS,
  JOB_ID_PARAMS as EXT_PARAMS,
  normalizeUrl as extNormalize,
  postingUrl as extPosting,
} from '../../../extension/lib/url.js';
import { APPLY_STEPS, JOB_ID_PARAMS, normalizeUrl, postingUrl } from '@/lib/extension';

// The dashboard (findJobByUrl) and the extension (sameTab) must agree on which urls are the same job page.
const CASES = [
  'https://WWW.Bayt.com/en/jobs/123/?utm=x#apply',
  'https://a.example/',
  'http://a.example:8080/x',
  'https://acme.com/careers?gh_jid=1',
  'https://acme.com/careers/?utm_source=li&gh_jid=1#app',
  'https://acme.com/careers?gh_jid=2&gh_src=abc',
  'https://jobs.acme.com/?ashby_jid=7f3c',
  'https://www.indeed.com/viewjob?jk=abc&from=serp&vjs=3',
  'https://www.indeed.com/jobs?q=php&l=Dubai&vjk=def',
  'https://www.glassdoor.com/job-listing/x.htm?jl=1009&pos=1',
  'https://www.linkedin.com/jobs/search/?keywords=php&currentJobId=42&trk=x',
  'https://acme.taleo.net/careersection/2/jobdetail.ftl?job=12345&tz=GMT',
  'https://a.example/j?req_id=9&jobId=3&ref=x',
  'https://a.example/j?JobID=3&req_id=9',
  'https://a.example/j?id=b&id=a',
  'https://a.example/j?id=&utm_medium=x&ref=y',
  'https://a.example/j?name=a%20b&id=a%20b',
];

describe('normalizeUrl (dashboard and extension)', () => {
  it('use the same job id parameters', () => {
    expect([...EXT_PARAMS]).toEqual([...JOB_ID_PARAMS]);
  });

  it.each(CASES)('agree on %s', (url) => {
    expect(extNormalize(url)).toBe(normalizeUrl(url));
  });

  it('keep job id parameters, sorted and lowercased, and drop tracking ones', () => {
    expect(normalizeUrl('https://acme.com/careers/?utm_source=li&gh_jid=1#app')).toBe('https://acme.com/careers?gh_jid=1');
    expect(normalizeUrl('https://acme.com/careers?gh_jid=2')).toBe('https://acme.com/careers?gh_jid=2');
    expect(normalizeUrl('https://a.example/j?req_id=9&jobId=3&ref=x')).toBe(normalizeUrl('https://a.example/j?JobID=3&req_id=9'));
    expect(normalizeUrl('https://a.example/j?id=b&id=a')).toBe('https://a.example/j?id=a&id=b');
    expect(normalizeUrl('https://a.example/x/?ref=board&trk=1')).toBe('https://a.example/x');
  });
});

const FORMS = [
  'https://jobs.lever.co/acme/5f1c/apply',
  'https://jobs.lever.co/acme/5f1c/apply/?lever-source=li#x',
  'https://jobs.eu.lever.co/acme/5f1c/apply',
  'https://jobs.ashbyhq.com/acme/7c2e/application',
  'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Eng_R1/apply',
  'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Eng_R1/apply/applyManually',
  'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Eng_R1/apply/autofillWithResume?jobId=1',
  'https://jobs.lever.co/acme/5f1c',
  'https://jobs.lever.co/acme/5f1c/apply/thanks',
  'https://jobs.ashbyhq.com/acme/7c2e/apply',
  'https://careers.acme.com/jobs/1/apply',
  'https://job-boards.greenhouse.io/acme/jobs/1#app',
];

describe('postingUrl (dashboard and extension)', () => {
  it('use the same apply steps', () => {
    expect(EXT_STEPS.map((r: { host: RegExp; path: RegExp }) => [String(r.host), String(r.path)])).toEqual(
      APPLY_STEPS.map((r) => [String(r.host), String(r.path)]),
    );
  });

  it.each(FORMS)('agree on %s', (url) => {
    expect(extPosting(url)).toBe(postingUrl(url));
  });

  it('take the application step off known ATS hosts only', () => {
    expect(postingUrl('https://jobs.lever.co/acme/5f1c/apply/?lever-source=li#x')).toBe('https://jobs.lever.co/acme/5f1c?lever-source=li');
    expect(postingUrl('https://jobs.ashbyhq.com/acme/7c2e/application')).toBe('https://jobs.ashbyhq.com/acme/7c2e');
    expect(postingUrl('https://acme.wd3.myworkdayjobs.com/c/job/x/apply/applyManually')).toBe('https://acme.wd3.myworkdayjobs.com/c/job/x');
    expect(postingUrl('https://jobs.lever.co/acme/5f1c')).toBeNull();
    expect(postingUrl('https://careers.acme.com/jobs/1/apply')).toBeNull();
    expect(postingUrl('https://jobs.ashbyhq.com/acme/7c2e/apply')).toBeNull();
    expect(postingUrl('https://evil-lever.co/acme/1/apply')).toBeNull();
  });
});
