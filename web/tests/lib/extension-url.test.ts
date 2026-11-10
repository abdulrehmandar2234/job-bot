import { describe, expect, it } from 'vitest';
import { JOB_ID_PARAMS as EXT_PARAMS, normalizeUrl as extNormalize } from '../../../extension/lib/url.js';
import { JOB_ID_PARAMS, normalizeUrl } from '@/lib/extension';

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
