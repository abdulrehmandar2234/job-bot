import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysAgo, mockFetch } from './helpers.ts';
import { timing } from '../src/sources/http.ts';
import { fetchCompany } from '../src/sources/index.ts';
import { BOARDS } from '../src/sources/boards.ts';
import { linkedin } from '../src/sources/linkedin.ts';
import { discover } from '../src/discover.ts';
import type { Company } from '../src/config.ts';

const cacheDir = mkdtempSync(join(tmpdir(), 'job-bot-sources-'));
before(() => {
  timing.scale = 0;
  process.env.JOB_BOT_HTTP_CACHE = cacheDir;
});
after(() => rmSync(cacheDir, { recursive: true, force: true }));
let net: ReturnType<typeof mockFetch>;
afterEach(() => net?.restore());

const co = (ats: Company['ats']): Company => ({ name: 'Acme', ats, token: 'acme' });

describe('company job boards (ATS)', () => {
  it('greenhouse: uses first_published as the post date and strips HTML', async () => {
    net = mockFetch({ 'boards-api.greenhouse.io/v1/boards/acme/jobs': { jobs: [{
      id: 7, title: 'Backend Engineer', location: { name: 'Dubai' }, offices: [{ name: 'Riyadh' }], absolute_url: 'https://x/7',
      content: '&lt;p&gt;Node &amp;amp; React&lt;/p&gt;', first_published: '2026-10-20T00:00:00Z', updated_at: '2026-10-28T00:00:00Z',
    }] } });
    const [j] = await fetchCompany(co('greenhouse'));
    assert.equal(j.id, 'greenhouse:acme:7');
    assert.equal(j.location, 'Dubai / Riyadh');
    assert.equal(j.posted_at, '2026-10-20T00:00:00Z');
    assert.equal(j.description, 'Node & React');
  });

  it('lever: joins description lists and converts createdAt', async () => {
    net = mockFetch({ 'api.lever.co': [{
      id: 'abc', text: 'Full Stack Developer', categories: { location: 'Amsterdam', allLocations: ['Utrecht'] }, hostedUrl: 'https://l/abc',
      descriptionPlain: 'Intro', lists: [{ text: 'Requirements', content: '<li>Laravel</li>' }], additionalPlain: 'Outro',
      createdAt: Date.parse('2026-10-25T00:00:00Z'),
    }] });
    const [j] = await fetchCompany(co('lever'));
    assert.equal(j.id, 'lever:acme:abc');
    assert.equal(j.location, 'Amsterdam / Utrecht');
    assert.match(j.description, /Intro\nRequirements\nLaravel\nOutro/);
    assert.equal(j.posted_at, '2026-10-25T00:00:00.000Z');
  });

  it('ashby: reads secondary locations and plain description', async () => {
    net = mockFetch({ 'api.ashbyhq.com': { jobs: [{
      id: 'q1', title: 'Engineer', location: 'Dubai', secondaryLocations: [{ location: 'Remote' }], jobUrl: 'https://a/q1',
      descriptionPlain: 'Plain text', publishedAt: '2026-10-26T00:00:00Z',
    }] } });
    const [j] = await fetchCompany(co('ashby'));
    assert.deepEqual([j.id, j.location, j.description], ['ashby:acme:q1', 'Dubai / Remote', 'Plain text']);
  });

  it('recruitee: parses "YYYY-MM-DD hh:mm:ss UTC" dates', async () => {
    net = mockFetch({ 'acme.recruitee.com/api/offers': { offers: [{
      id: 3, title: 'PHP Developer', location: 'Rotterdam', locations: [{ city: 'Rotterdam', country: 'Netherlands' }],
      careers_url: 'https://r/3', description: '<p>Laravel</p>', requirements: '<p>PHP</p>', published_at: '2026-10-08 10:28:31 UTC',
    }] } });
    const [j] = await fetchCompany(co('recruitee'));
    assert.equal(j.posted_at, '2026-10-08T10:28:31.000Z');
    assert.equal(j.description, 'Laravel\nPHP');
  });

  it('workable: retries when rate-limited', async () => {
    let n = 0;
    net = mockFetch({ 'apply.workable.com': () => (++n === 1 ? new Response('slow down', { status: 429 }) : { jobs: [{
      shortcode: 'W1', title: 'Node Developer', city: 'Dubai', country: 'United Arab Emirates', locations: [],
      description: 'Node', published_on: '2026-10-27',
    }] }) });
    const [j] = await fetchCompany(co('workable'));
    assert.equal(n, 2);
    assert.equal(j.id, 'workable:acme:W1');
    assert.equal(j.url, 'https://apply.workable.com/acme/j/W1/');
    assert.equal(j.location, 'Dubai, United Arab Emirates');
  });

  it('workable: retries a Cloudflare 403', async () => {
    let n = 0;
    net = mockFetch({ 'apply.workable.com': () => (++n === 1 ? new Response('', { status: 403 }) : { jobs: [] }) });
    assert.deepEqual(await fetchCompany(co('workable')), []);
    assert.equal(n, 2);
  });

  it('workable: gives up on a 404', async () => {
    net = mockFetch({});
    await assert.rejects(fetchCompany(co('workable')), /404/);
  });

  it('smartrecruiters: only loads details for postings that can pass the filters', async () => {
    net = mockFetch({
      'postings?limit=100': { totalFound: 3, content: [
        { id: 'p1', name: 'Senior Backend Engineer', location: { fullLocation: 'Riyadh, Saudi Arabia' }, releasedDate: daysAgo(1) },
        { id: 'p2', name: 'Sales Manager', location: { fullLocation: 'Riyadh, Saudi Arabia' }, releasedDate: daysAgo(1) },
        { id: 'p3', name: 'Backend Engineer', location: { fullLocation: 'Paris, France' }, releasedDate: daysAgo(1) },
      ] },
      'postings/p1': { postingUrl: 'https://s/p1', jobAd: { sections: { a: { text: '<p>Node</p>' }, b: { text: 'React' } } } },
    });
    const jobs = await fetchCompany(co('smartrecruiters'));
    assert.deepEqual(jobs.map((j) => j.id), ['smartrecruiters:acme:p1']);
    assert.equal(jobs[0].description, 'Node\nReact');
    assert.ok(!net.calls.some((u) => u.includes('/p2') || u.includes('/p3')));
  });

  it('throws on HTTP errors so the fetch run records them', async () => {
    net = mockFetch({});
    await assert.rejects(fetchCompany(co('greenhouse')), /404/);
  });
});

describe('remote boards', () => {
  it('himalayas: searches as Pakistan, keeps fresh jobs and labels the region', async () => {
    const now = Math.floor(Date.now() / 1000);
    net = mockFetch({ 'himalayas.app/jobs/api/search': (url: string) => (url.includes('page=1') && url.includes('q=laravel') ? { jobs: [
      { guid: 'https://himalayas.app/companies/acme/jobs/dev', companyName: 'Acme', title: 'Laravel Dev', pubDate: now - 86400,
        locationRestrictions: ['Pakistan', 'India'], description: '<p>PHP</p>', applicationLink: 'https://apply' },
      { guid: 'https://himalayas.app/companies/old/jobs/dev', companyName: 'Old', title: 'Old', pubDate: now - 60 * 86400 },
    ] } : { jobs: [] }) });
    const jobs = await BOARDS.himalayas();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 'himalayas:acme/jobs/dev');
    assert.equal(jobs[0].location, 'Remote — Pakistan, India');
    assert.ok(net.calls.every((u) => u.includes('country=PK')));
  });

  it('remotive: marks unstated regions', async () => {
    net = mockFetch({ 'remotive.com': { jobs: [{ id: 1, company_name: 'A', title: 'Dev', candidate_required_location: '',
      url: 'u', description: '<b>Node</b>', publication_date: '2026-10-27T10:00:00' }] } });
    const [j] = await BOARDS.remotive();
    assert.equal(j.location, 'Remote — not stated');
    assert.equal(j.posted_at, '2026-10-27T10:00:00.000Z');
  });

  it('remoteok: skips the legal notice row and adds tags to the description', async () => {
    net = mockFetch({ 'remoteok.com/api': [{ legal: 'notice' }, { id: 9, position: 'React Dev', company: 'B', location: 'Worldwide',
      url: 'u', description: 'Build UI', tags: ['react', 'typescript'], date: '2026-10-27T00:00:00Z' }] });
    const jobs = await BOARDS.remoteok();
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].description, /react, typescript/);
  });
});

describe('linkedin (guest search)', () => {
  const card = (id: string, title: string) => `<li><div data-entity-urn="urn:li:jobPosting:${id}">
    <h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle"><a>Acme &amp; Co</a></h4>
    <span class="job-search-card__location">Dubai, United Arab Emirates</span><time datetime="2026-10-27">1 day ago</time></div></li>`;

  it('parses cards, skips excluded titles before loading details, and labels remote searches', async () => {
    net = mockFetch({
      'seeMoreJobPostings/search': (url: string) => (new URL(url).searchParams.get('keywords') === 'laravel'
        ? card('111', 'Laravel Developer') + card('222', 'Sales Manager') : ''),
      'jobPosting/111': '<div class="show-more-less-html__markup">Build <b>Laravel</b> APIs</div>\n<button>',
    });
    const jobs = await linkedin();
    const onsite = jobs.find((j) => j.location.startsWith('Dubai'));
    assert.ok(onsite);
    assert.equal(onsite.id, 'linkedin:111');
    assert.equal(onsite.company, 'Acme & Co');
    assert.equal(onsite.posted_at, '2026-10-27T00:00:00.000Z');
    assert.match(onsite.description, /Build Laravel APIs/);
    assert.ok(!net.calls.some((u) => u.includes('jobPosting/222')));
    const searches = net.calls.filter((u) => u.includes('seeMoreJobPostings'));
    assert.ok(searches.some((u) => u.includes('f_WT=2') && u.includes('location=Pakistan')));
    assert.ok(searches.every((u) => u.includes('f_TPR=r')));
  });

  it('stops LinkedIn for today on the first 429, without retrying', async () => {
    net = mockFetch({ linkedin: () => new Response('', { status: 429 }) });
    await assert.rejects(linkedin(), /429 LinkedIn rate limit: stopping LinkedIn for today/);
    assert.equal(net.calls.length, 1);
  });

  it('still retries a LinkedIn 5xx and keeps its browser headers', async () => {
    let n = 0;
    const agents: string[] = [];
    net = mockFetch({ 'seeMoreJobPostings/search': (_u: string, init?: RequestInit) => {
      agents.push((init?.headers as Record<string, string>)['user-agent']);
      return ++n === 1 ? new Response('', { status: 503 }) : '';
    } });
    await linkedin();
    assert.equal(net.calls[0], net.calls[1]);
    assert.match(agents[0], /^Mozilla\//);
  });
});

describe('discover', () => {
  it('finds boards with jobs in target countries, best first', async () => {
    net = mockFetch({
      'boards-api.greenhouse.io/v1/boards/acme/': { jobs: [{ location: { name: 'Dubai' } }, { location: { name: 'London' } }] },
      'api.lever.co/v0/postings/acme': [{ categories: { location: 'Berlin' } }],
    });
    const hits = await discover(['acme']);
    assert.deepEqual(hits.map((h) => [h.ats, h.jobs, h.target]), [['greenhouse', 2, 1], ['lever', 1, 0]]);
  });

  it('probes each missing board once: a 404 is not retried', async () => {
    net = mockFetch({});
    assert.deepEqual(await discover(['nobody']), []);
    assert.equal(net.calls.length, 6);
    assert.equal(new Set(net.calls).size, 6);
  });
});
