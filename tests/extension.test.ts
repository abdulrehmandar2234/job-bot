// Pure logic of the Chrome extension (extension/lib/*.js): no browser, no chrome.* and no dashboard needed.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeResult, lookupJob, missingFields, OFFLINE, sendJob } from '../extension/lib/api.js';
import { findJobPosting, guessFromTitle, jobFromPage, jobFromPosting, postingLocation } from '../extension/lib/jobposting.js';
import { cleanText, decodeEntities, htmlToText } from '../extension/lib/text.js';
import { isHttpUrl, normalizeUrl, sourceFromUrl } from '../extension/lib/url.js';

const posting = (over: Record<string, unknown> = {}) => ({
  '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Senior Backend Engineer',
  hiringOrganization: { '@type': 'Organization', name: 'Acme FZ-LLC' },
  jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: 'Dubai', addressCountry: 'AE' } },
  description: '<p>Build <b>APIs</b>.</p><ul><li>Node.js</li><li>Postgres</li></ul>', datePosted: '2026-10-20T08:00:00Z',
  ...over,
});

describe('text', () => {
  it('decodes named and numeric entities and leaves unknown ones', () => {
    assert.equal(decodeEntities('A &amp; B &lt;3 &#8211; &#x2014; &nbsp;x &bogus;'), 'A & B <3 – —  x &bogus;');
  });

  it('cleans whitespace but keeps paragraphs', () => {
    assert.equal(cleanText('  a \t b \r\n\r\n\r\n\n c    '), 'a b\n\nc');
    assert.equal(cleanText(null), '');
  });

  it('turns description HTML into text with bullets and line breaks', () => {
    assert.equal(htmlToText('<p>Build <b>APIs</b>.</p><ul><li>Node.js</li><li>Postgres</li></ul>Line<br>two<script>x()</script>'),
      'Build APIs.\n\n• Node.js\n• Postgres\nLine\ntwo');
  });

  it('handles entity-escaped HTML from JSON-LD', () => {
    assert.equal(htmlToText('&lt;p&gt;Tom &amp;amp; Jerry&lt;/p&gt;&lt;p&gt;Two&lt;/p&gt;'), 'Tom & Jerry\n\nTwo');
  });
});

describe('url', () => {
  it('accepts only absolute http(s) urls', () => {
    assert.equal(isHttpUrl('https://a.example/x'), true);
    assert.equal(isHttpUrl('http://a.example'), true);
    for (const u of ['javascript:alert(1)', 'chrome://extensions', 'file:///etc/passwd', '/jobs/1', '', undefined]) assert.equal(isHttpUrl(u), false, String(u));
  });

  it('normalizes without query, hash and trailing slash', () => {
    assert.equal(normalizeUrl('https://WWW.Bayt.com/en/jobs/123/?utm=x#apply'), 'https://www.bayt.com/en/jobs/123');
    assert.equal(normalizeUrl('https://a.example/'), 'https://a.example');
    assert.equal(normalizeUrl('http://a.example:8080/x'), 'http://a.example:8080/x');
    assert.equal(normalizeUrl('ftp://a.example/x'), null);
  });

  it('derives the source from known job boards, else "extension"', () => {
    assert.equal(sourceFromUrl('https://www.gulftalent.com/uae/jobs/1'), 'gulftalent');
    assert.equal(sourceFromUrl('https://ae.linkedin.com/jobs/view/1'), 'linkedin');
    assert.equal(sourceFromUrl('https://www.bayt.com/en/uae/jobs/x'), 'bayt');
    assert.equal(sourceFromUrl('https://job-boards.greenhouse.io/careem/jobs/1'), 'greenhouse');
    assert.equal(sourceFromUrl('https://www.naukrigulf.com/x'), 'naukrigulf');
    assert.equal(sourceFromUrl('https://careers.acme.com/jobs/1'), 'extension');
    assert.equal(sourceFromUrl('https://bayt.com.evil.example/x'), 'extension');
    assert.equal(sourceFromUrl('https://notbayt.com/x'), 'extension');
    assert.equal(sourceFromUrl('not a url'), 'extension');
  });
});

describe('findJobPosting', () => {
  it('finds a posting in a plain object, an array, a @graph and a typed list', () => {
    const p = posting();
    assert.equal(findJobPosting([JSON.stringify(p)])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify([{ '@type': 'Organization' }, p])])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify({ '@graph': [{ '@type': 'WebPage' }, p] })])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify({ ...p, '@type': ['Thing', 'JobPosting'] })])?.title, p.title);
    assert.equal(findJobPosting([JSON.stringify({ ...p, '@type': 'http://schema.org/JobPosting' })])?.title, p.title);
  });

  it('skips invalid JSON and other types, and returns null when there is none', () => {
    assert.equal(findJobPosting(['{oops', JSON.stringify({ '@type': 'BreadcrumbList' }), JSON.stringify(posting({ title: 'Second' }))])?.title, 'Second');
    assert.equal(findJobPosting(['{oops', 'null', '42']), null);
    assert.equal(findJobPosting(undefined), null);
  });
});

describe('postingLocation', () => {
  it('spells out country codes so the bot recognizes the country', () => {
    assert.equal(postingLocation(posting()), 'Dubai, United Arab Emirates');
  });

  it('joins several places and accepts plain strings and country objects', () => {
    assert.equal(postingLocation({ jobLocation: [
      { address: { addressLocality: 'Riyadh', addressCountry: { '@type': 'Country', name: 'Saudi Arabia' } } },
      { address: 'Amsterdam, Netherlands' }, 'Jeddah', { name: 'HQ' },
    ] }), 'Riyadh, Saudi Arabia; Amsterdam, Netherlands; Jeddah; HQ');
  });

  it('adds Remote with the allowed countries for TELECOMMUTE jobs', () => {
    assert.equal(postingLocation({ jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: [{ '@type': 'Country', name: 'PK' }, { name: 'UAE' }] }),
      'Remote (Pakistan, UAE)');
    assert.equal(postingLocation({ jobLocationType: ['TELECOMMUTE'] }), 'Remote');
    assert.equal(postingLocation({}), '');
  });
});

describe('jobFromPosting', () => {
  it('maps a JobPosting to the fields /api/import takes', () => {
    assert.deepEqual(jobFromPosting(posting(), 'https://www.gulftalent.com/uae/jobs/senior-backend-1?ref=x'), {
      source: 'gulftalent', company: 'Acme FZ-LLC', title: 'Senior Backend Engineer', location: 'Dubai, United Arab Emirates',
      url: 'https://www.gulftalent.com/uae/jobs/senior-backend-1?ref=x', description: 'Build APIs.\n\n• Node.js\n• Postgres',
      posted_at: '2026-10-20',
    });
  });

  it('prefers the posting url, decodes entities and copes with missing fields', () => {
    const j = jobFromPosting(posting({ url: 'https://careers.acme.com/jobs/9', title: 'R&amp;D Engineer', hiringOrganization: 'Acme',
      description: undefined, datePosted: 'last week' }), 'https://www.linkedin.com/jobs/view/1');
    assert.equal(j.url, 'https://careers.acme.com/jobs/9');
    assert.equal(j.source, 'extension');
    assert.equal(j.title, 'R&D Engineer');
    assert.equal(j.company, 'Acme');
    assert.equal(j.description, '');
    assert.equal(j.posted_at, null);
    assert.equal(jobFromPosting(posting({ url: 'javascript:x' }), 'https://a.example/1').url, 'https://a.example/1');
  });
});

describe('guessFromTitle', () => {
  it('splits "title at company" and drops the site name', () => {
    assert.deepEqual(guessFromTitle('Backend Engineer at Acme | LinkedIn', 'LinkedIn'), { title: 'Backend Engineer', company: 'Acme' });
  });

  it('takes the first two parts otherwise', () => {
    assert.deepEqual(guessFromTitle('Laravel Developer - Beta Corp - Careers'), { title: 'Laravel Developer', company: 'Beta Corp' });
    assert.deepEqual(guessFromTitle('Full-Stack Developer'), { title: 'Full-Stack Developer', company: '' });
    assert.deepEqual(guessFromTitle(''), { title: '', company: '' });
  });
});

describe('jobFromPage', () => {
  const page = { url: 'https://careers.acme.com/jobs/1', title: 'PHP Developer - Acme', siteName: '', jsonLd: [] as string[], selection: '', mainText: ' Main  text ' };

  it('uses JSON-LD when the page has a JobPosting', () => {
    const r = jobFromPage({ ...page, jsonLd: [JSON.stringify(posting())] });
    assert.equal(r.method, 'jsonld');
    assert.equal(r.job.title, 'Senior Backend Engineer');
  });

  it('falls back to the page title and the selected text', () => {
    assert.deepEqual(jobFromPage({ ...page, selection: '  We need\n\n\n\na PHP dev ' }), {
      method: 'page',
      job: { source: 'extension', company: 'Acme', title: 'PHP Developer', location: '', url: page.url, description: 'We need\n\na PHP dev', posted_at: null },
    });
  });

  it('uses the main text without a selection, also when the JSON-LD posting has no title', () => {
    const r = jobFromPage({ ...page, jsonLd: [JSON.stringify(posting({ title: '' }))] });
    assert.equal(r.method, 'page');
    assert.equal(r.job.description, 'Main text');
    assert.equal(jobFromPage({ ...page, mainText: 'x'.repeat(30000) }).job.description.length, 20000);
  });
});

describe('api', () => {
  type Call = { url: string; init?: RequestInit };
  const fake = (status: number, body: unknown, calls: Call[] = []) => async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  const job = { source: 'extension', company: 'Acme', title: 'Dev', location: '', url: 'https://a.example/1', description: '', posted_at: null };

  it('posts one job as a list and returns its result', async () => {
    const calls: Call[] = [];
    const result = { url: job.url, outcome: 'added', id: 'extension:abc', score: 70 };
    assert.deepEqual(await sendJob(job, fake(200, { received: 1, results: [result] }, calls)), { ok: true, result });
    assert.equal(calls[0].url, 'http://localhost:3100/api/import');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), [job]);
  });

  it('explains a refused job, an error status and a stopped dashboard', async () => {
    assert.match(((await sendJob(job, fake(200, { added: 0, results: [] }))) as { error: string }).error, /did not accept/);
    assert.deepEqual(await sendJob(job, fake(403, 'Forbidden origin')), { ok: false, status: 403, error: 'The dashboard answered 403.' });
    assert.deepEqual(await sendJob(job, offline), { ok: false, error: OFFLINE });
  });

  it('looks up a tab url', async () => {
    const calls: Call[] = [];
    assert.deepEqual(await lookupJob('https://a.example/1?x=1&y=2', fake(200, { job: { id: 'a' } }, calls)), { ok: true, job: { id: 'a' } });
    assert.equal(calls[0].url, 'http://localhost:3100/api/jobs/lookup?url=https%3A%2F%2Fa.example%2F1%3Fx%3D1%26y%3D2');
    assert.deepEqual(await lookupJob('https://a.example/2', fake(200, { job: null })), { ok: true, job: null });
    assert.deepEqual(await lookupJob('https://a.example/2', fake(400, { error: 'url must be an http(s) URL' })),
      { ok: false, status: 400, error: 'url must be an http(s) URL' });
    assert.deepEqual(await lookupJob('https://a.example/2', offline), { ok: false, error: OFFLINE });
  });

  it('describes each import outcome', () => {
    assert.equal(describeResult({ outcome: 'added', score: 72, ai_score: null }), 'Added with score 72.');
    assert.equal(describeResult({ outcome: 'filtered', filter_reason: 'title is not an engineering role' }),
      'Added, but filtered out: title is not an engineering role.');
    assert.equal(describeResult({ outcome: 'known', status: 'applied', score: 60, ai_score: 81 }),
      'Already in job-bot (applied, AI score 81, keyword score 60).');
    assert.match(describeResult({ outcome: 'error' }), /could not save/);
  });

  it('lists missing required fields', () => {
    assert.deepEqual(missingFields(job), []);
    assert.deepEqual(missingFields({ ...job, title: '  ', company: undefined }), ['title', 'company']);
  });
});
