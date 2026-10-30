import { after, afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysAgo, mockFetch } from './helpers.ts';
import { timing } from '../src/sources/http.ts';
import { fetchCompany, workdayAgeDays, workdaySite } from '../src/sources/index.ts';
import { BOARDS } from '../src/sources/boards.ts';
import { linkedin } from '../src/sources/linkedin.ts';
import { discover, workdayToken } from '../src/discover.ts';
import { config, type Company } from '../src/config.ts';

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
    net = mockFetch({
      'boards-api.greenhouse.io/v1/boards/acme/jobs': {
        jobs: [
          {
            id: 7,
            title: 'Backend Engineer',
            location: { name: 'Dubai' },
            offices: [{ name: 'Riyadh' }],
            absolute_url: 'https://x/7',
            content: '&lt;p&gt;Node &amp;amp; React&lt;/p&gt;',
            first_published: '2026-10-20T00:00:00Z',
            updated_at: '2026-10-28T00:00:00Z',
          },
        ],
      },
    });
    const [j] = await fetchCompany(co('greenhouse'));
    assert.equal(j.id, 'greenhouse:acme:7');
    assert.equal(j.location, 'Dubai / Riyadh');
    assert.equal(j.posted_at, '2026-10-20T00:00:00Z');
    assert.equal(j.description, 'Node & React');
  });

  it('lever: joins description lists and converts createdAt', async () => {
    net = mockFetch({
      'api.lever.co': [
        {
          id: 'abc',
          text: 'Full Stack Developer',
          categories: { location: 'Amsterdam', allLocations: ['Utrecht'] },
          hostedUrl: 'https://l/abc',
          descriptionPlain: 'Intro',
          lists: [{ text: 'Requirements', content: '<li>Laravel</li>' }],
          additionalPlain: 'Outro',
          createdAt: Date.parse('2026-10-25T00:00:00Z'),
        },
      ],
    });
    const [j] = await fetchCompany(co('lever'));
    assert.equal(j.id, 'lever:acme:abc');
    assert.equal(j.location, 'Amsterdam / Utrecht');
    assert.match(j.description, /Intro\nRequirements\nLaravel\nOutro/);
    assert.equal(j.posted_at, '2026-10-25T00:00:00.000Z');
  });

  it('ashby: reads secondary locations and plain description', async () => {
    net = mockFetch({
      'api.ashbyhq.com': {
        jobs: [
          {
            id: 'q1',
            title: 'Engineer',
            location: 'Dubai',
            secondaryLocations: [{ location: 'Remote' }],
            jobUrl: 'https://a/q1',
            descriptionPlain: 'Plain text',
            publishedAt: '2026-10-26T00:00:00Z',
          },
        ],
      },
    });
    const [j] = await fetchCompany(co('ashby'));
    assert.deepEqual([j.id, j.location, j.description], ['ashby:acme:q1', 'Dubai / Remote', 'Plain text']);
  });

  it('recruitee: parses "YYYY-MM-DD hh:mm:ss UTC" dates', async () => {
    net = mockFetch({
      'acme.recruitee.com/api/offers': {
        offers: [
          {
            id: 3,
            title: 'PHP Developer',
            location: 'Rotterdam',
            locations: [{ city: 'Rotterdam', country: 'Netherlands' }],
            careers_url: 'https://r/3',
            description: '<p>Laravel</p>',
            requirements: '<p>PHP</p>',
            published_at: '2026-10-08 10:28:31 UTC',
          },
        ],
      },
    });
    const [j] = await fetchCompany(co('recruitee'));
    assert.equal(j.posted_at, '2026-10-08T10:28:31.000Z');
    assert.equal(j.description, 'Laravel\nPHP');
  });

  it('workable: retries when rate-limited', async () => {
    let n = 0;
    net = mockFetch({
      'apply.workable.com': () =>
        ++n === 1
          ? new Response('slow down', { status: 429 })
          : {
              jobs: [
                {
                  shortcode: 'W1',
                  title: 'Node Developer',
                  city: 'Dubai',
                  country: 'United Arab Emirates',
                  locations: [],
                  description: 'Node',
                  published_on: '2026-10-27',
                },
              ],
            },
    });
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
      'postings?limit=100': {
        totalFound: 3,
        content: [
          { id: 'p1', name: 'Senior Backend Engineer', location: { fullLocation: 'Riyadh, Saudi Arabia' }, releasedDate: daysAgo(1) },
          { id: 'p2', name: 'Sales Manager', location: { fullLocation: 'Riyadh, Saudi Arabia' }, releasedDate: daysAgo(1) },
          { id: 'p3', name: 'Backend Engineer', location: { fullLocation: 'Paris, France' }, releasedDate: daysAgo(1) },
        ],
      },
      'postings/p1': { postingUrl: 'https://s/p1', jobAd: { sections: { a: { text: '<p>Node</p>' }, b: { text: 'React' } } } },
    });
    const jobs = await fetchCompany(co('smartrecruiters'));
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['smartrecruiters:acme:p1'],
    );
    assert.equal(jobs[0].description, 'Node\nReact');
    assert.ok(!net.calls.some((u) => u.includes('/p2') || u.includes('/p3')));
  });

  it('smartrecruiters: a failed detail call skips that posting and keeps the rest, as a partial error', async () => {
    const p = (id: string) => ({
      id,
      name: 'Senior Backend Engineer',
      location: { fullLocation: 'Riyadh, Saudi Arabia' },
      releasedDate: daysAgo(1),
    });
    net = mockFetch({
      'postings?limit=100': { totalFound: 3, content: [p('p1'), p('p2'), p('p3')] },
      'postings/p1': { postingUrl: 'https://s/p1', jobAd: { sections: {} } },
      'postings/p3': { postingUrl: 'https://s/p3', jobAd: { sections: {} } },
    });
    const jobs = await fetchCompany(co('smartrecruiters'));
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['smartrecruiters:acme:p1', 'smartrecruiters:acme:p3'],
    );
    assert.match(jobs.partialError ?? '', /^partial: kept 2 postings; 1 of 3 details failed \(first: p2: .*404/);
  });

  it('smartrecruiters: a failed later list page keeps the postings already listed', async () => {
    const p = (id: string) => ({
      id,
      name: 'Senior Backend Engineer',
      location: { fullLocation: 'Riyadh, Saudi Arabia' },
      releasedDate: daysAgo(1),
    });
    net = mockFetch({
      'postings?limit=100&offset=0': { totalFound: 150, content: [p('p1')] },
      'postings?limit=100&offset=100': () => new Response('', { status: 400 }),
      'postings/p1': { postingUrl: 'https://s/p1', jobAd: { sections: {} } },
    });
    const jobs = await fetchCompany(co('smartrecruiters'));
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['smartrecruiters:acme:p1'],
    );
    assert.match(jobs.partialError ?? '', /list stopped after 1 postings: .*400/);
  });

  it('smartrecruiters: still throws when every detail call fails', async () => {
    const p = (id: string) => ({
      id,
      name: 'Senior Backend Engineer',
      location: { fullLocation: 'Riyadh, Saudi Arabia' },
      releasedDate: daysAgo(1),
    });
    net = mockFetch({ 'postings?limit=100': { totalFound: 1, content: [p('p1')] } });
    await assert.rejects(fetchCompany(co('smartrecruiters')), /1 of 1 details failed/);
  });

  it('throws on HTTP errors so the fetch run records them', async () => {
    net = mockFetch({});
    await assert.rejects(fetchCompany(co('greenhouse')), /404/);
  });
});

describe('workday', () => {
  const wd: Company = { name: 'Acme', ats: 'workday', token: 'acme/wd3/AcmeCareers' };
  const api = 'acme.wd3.myworkdayjobs.com/wday/cxs/acme/AcmeCareers';
  const posting = (n: number, o: Record<string, string> = {}) => ({
    title: 'Backend Engineer',
    externalPath: `/job/Dubai/Backend-Engineer_R${n}`,
    locationsText: 'Dubai, United Arab Emirates',
    postedOn: 'Posted 2 Days Ago',
    ...o,
  });

  it('reads the token as tenant, host and site', () => {
    assert.deepEqual(workdaySite('acme/wd3/AcmeCareers'), {
      tenant: 'acme',
      api: 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/AcmeCareers',
      site: 'https://acme.wd3.myworkdayjobs.com/AcmeCareers',
    });
    assert.throws(() => workdaySite('acme'), /<tenant>\/<wdN>\/<site>/);
    assert.throws(() => workdaySite('acme/x3/Site'), /<tenant>\/<wdN>\/<site>/);
  });

  it('parses "Posted ..." ages', () => {
    assert.deepEqual(
      ['Posted Today', 'Posted Yesterday', 'Posted 3 Days Ago', 'Posted 30+ Days Ago', ''].map((x) => workdayAgeDays(x)),
      [0, 1, 3, 30, null],
    );
  });

  it('pages with POST until the total is reached, and only loads details for likely matches', async () => {
    const bodies: any[] = [];
    const page1 = Array.from({ length: 20 }, (_, i) => posting(i, i === 0 ? {} : { locationsText: 'Paris, France' }));
    const page2 = [
      posting(100, { title: 'Sales Manager' }),
      posting(101, { locationsText: '3 Locations' }),
      posting(102, { locationsText: 'Remote, Pakistan' }),
      posting(103, { postedOn: 'Posted 30+ Days Ago' }),
    ];
    net = mockFetch({
      [`${api}/jobs`]: (_u: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        bodies.push({ ...body, method: init?.method });
        return body.offset === 0 ? { total: 24, jobPostings: page1 } : { total: 0, jobPostings: page2 };
      },
      [`${api}/job/`]: (url: string) => ({
        jobPostingInfo: {
          id: `guid-${url.split('_R').pop()}`,
          title: 'Backend Engineer',
          jobDescription: '<p>Node &amp; React</p>',
          location: 'Dubai, United Arab Emirates',
          additionalLocations: ['Riyadh, Saudi Arabia'],
          startDate: '2026-10-27',
          externalUrl: `https://acme.wd3.myworkdayjobs.com/AcmeCareers${new URL(url).pathname.split('AcmeCareers')[1]}`,
        },
      }),
    });
    const jobs = await fetchCompany(wd);
    assert.deepEqual(
      bodies.map((b) => [b.method, b.limit, b.offset, b.searchText]),
      [
        ['POST', 20, 0, ''],
        ['POST', 20, 20, ''],
      ],
    );
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['workday:acme:guid-0', 'workday:acme:guid-101', 'workday:acme:guid-102'],
    );
    const details = net.calls.filter((u) => u.includes('/job/'));
    assert.equal(details.length, 3);
    assert.ok(!details.some((u) => /_R(1|100|103)$/.test(u)));
    const [j] = jobs;
    assert.equal(j.source, 'workday');
    assert.equal(j.location, 'Dubai, United Arab Emirates / Riyadh, Saudi Arabia');
    assert.equal(j.description, 'Node & React');
    assert.equal(j.posted_at, '2026-10-27T00:00:00.000Z');
    assert.equal(j.url, 'https://acme.wd3.myworkdayjobs.com/AcmeCareers/job/Dubai/Backend-Engineer_R0');
  });

  it('stops at the page cap even when the total is larger', async () => {
    net = mockFetch({
      [`${api}/jobs`]: { total: 5000, jobPostings: Array.from({ length: 20 }, (_, i) => posting(i, { title: 'Sales' })) },
    });
    assert.deepEqual(await fetchCompany(wd), []);
    assert.equal(net.calls.length, 25);
  });

  it('retries a failed search POST and skips a posting whose detail is gone', async () => {
    let n = 0;
    net = mockFetch({
      [`${api}/jobs`]: () => (++n === 1 ? new Response('', { status: 503 }) : { total: 2, jobPostings: [posting(1), posting(2)] }),
      [`${api}/job/Dubai/Backend-Engineer_R2`]: { jobPostingInfo: { id: 'g2', jobDescription: 'x' } },
    });
    const jobs = await fetchCompany(wd);
    assert.equal(n, 2);
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['workday:acme:g2'],
    );
    assert.equal(jobs[0].location, 'Dubai, United Arab Emirates');
    assert.equal(jobs[0].url, 'https://acme.wd3.myworkdayjobs.com/AcmeCareers/job/Dubai/Backend-Engineer_R2');
  });
});

describe('remote boards', () => {
  it('himalayas: searches as Pakistan, keeps fresh jobs and labels the region', async () => {
    const now = Math.floor(Date.now() / 1000);
    net = mockFetch({
      'himalayas.app/jobs/api/search': (url: string) =>
        url.includes('page=1') && url.includes('q=laravel')
          ? {
              jobs: [
                {
                  guid: 'https://himalayas.app/companies/acme/jobs/dev',
                  companyName: 'Acme',
                  title: 'Laravel Dev',
                  pubDate: now - 86400,
                  locationRestrictions: ['Pakistan', 'India'],
                  description: '<p>PHP</p>',
                  applicationLink: 'https://apply',
                },
                { guid: 'https://himalayas.app/companies/old/jobs/dev', companyName: 'Old', title: 'Old', pubDate: now - 60 * 86400 },
              ],
            }
          : { jobs: [] },
    });
    const jobs = await BOARDS.himalayas();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, 'himalayas:acme/jobs/dev');
    assert.equal(jobs[0].location, 'Remote — Pakistan, India');
    assert.ok(net.calls.every((u) => u.includes('country=PK')));
  });

  it('himalayas: a 429 on a later page keeps the pages already fetched and stops', async () => {
    const now = Math.floor(Date.now() / 1000);
    const hit = (slug: string) => ({
      guid: `https://himalayas.app/companies/acme/jobs/${slug}`,
      companyName: 'Acme',
      title: 'Dev',
      pubDate: now - 86400,
    });
    net = mockFetch({
      'himalayas.app/jobs/api/search': (url: string) =>
        /page=1$/.test(url) && url.includes('q=laravel') ? { jobs: [hit('a'), hit('b')] } : new Response('', { status: 429 }),
    });
    const jobs = await BOARDS.himalayas();
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['himalayas:acme/jobs/a', 'himalayas:acme/jobs/b'],
    );
    assert.match(jobs.partialError ?? '', /^partial: kept 2 postings, then .*429.*page=2/);
    assert.ok(!net.calls.some((u) => u.includes('q=php')));
  });

  it('himalayas: a 429 on the very first page is still an error', async () => {
    net = mockFetch({ 'himalayas.app': () => new Response('', { status: 429 }) });
    await assert.rejects(BOARDS.himalayas(), /429/);
  });

  it('remotive: marks unstated regions', async () => {
    net = mockFetch({
      'remotive.com': {
        jobs: [
          {
            id: 1,
            company_name: 'A',
            title: 'Dev',
            candidate_required_location: '',
            url: 'u',
            description: '<b>Node</b>',
            publication_date: '2026-10-27T10:00:00',
          },
        ],
      },
    });
    const [j] = await BOARDS.remotive();
    assert.equal(j.location, 'Remote — not stated');
    assert.equal(j.posted_at, '2026-10-27T10:00:00.000Z');
  });

  it('remoteok: skips the legal notice row and adds tags to the description', async () => {
    net = mockFetch({
      'remoteok.com/api': [
        { legal: 'notice' },
        {
          id: 9,
          position: 'React Dev',
          company: 'B',
          location: 'Worldwide',
          url: 'u',
          description: 'Build UI',
          tags: ['react', 'typescript'],
          date: '2026-10-27T00:00:00Z',
        },
      ],
    });
    const jobs = await BOARDS.remoteok();
    assert.equal(jobs.length, 1);
    assert.match(jobs[0].description, /react, typescript/);
  });
});

describe('arbeitnow', () => {
  const now = Math.floor(Date.now() / 1000);
  const job = (slug: string, o: Record<string, unknown> = {}) => ({
    slug,
    company_name: 'Acme',
    title: 'Full Stack Developer',
    description: '&lt;p&gt;Laravel &amp;amp; Vue&lt;/p&gt;',
    remote: false,
    url: `https://www.arbeitnow.com/jobs/companies/acme/${slug}`,
    tags: [],
    job_types: [],
    location: 'Berlin',
    created_at: now - 3600,
    ...o,
  });

  it('keeps Netherlands and remote postings, labels remote ones and decodes the description', async () => {
    net = mockFetch({
      'arbeitnow.com/api/job-board-api': (url: string) =>
        url.endsWith('page=1')
          ? {
              data: [
                job('berlin-dev'),
                job('ams-dev', { location: 'Amsterdam' }),
                job('remote-dev', { remote: true, location: 'Monheim am Rhein' }),
              ],
              links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
            }
          : { data: [job('utrecht-dev', { location: 'Utrecht, Netherlands' })], links: { next: null } },
    });
    const jobs = await BOARDS.arbeitnow();
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['arbeitnow:ams-dev', 'arbeitnow:remote-dev', 'arbeitnow:utrecht-dev'],
    );
    assert.equal(jobs[0].location, 'Amsterdam');
    assert.equal(jobs[1].location, 'Remote — Monheim am Rhein');
    assert.equal(jobs[0].description, 'Laravel & Vue');
    assert.equal(jobs[0].source, 'arbeitnow');
    assert.equal(jobs[0].posted_at, new Date((now - 3600) * 1000).toISOString());
    assert.equal(net.calls.length, 2);
  });

  it('a failed later page keeps the earlier pages as a partial result', async () => {
    net = mockFetch({
      'arbeitnow.com/api/job-board-api': (url: string) =>
        url.endsWith('page=1')
          ? { data: [job('ams-dev', { location: 'Amsterdam' })], links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' } }
          : new Response('', { status: 404 }),
    });
    const jobs = await BOARDS.arbeitnow();
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['arbeitnow:ams-dev'],
    );
    assert.match(jobs.partialError ?? '', /404/);
  });

  it('stops paging once postings are older than maxAgeDays', async () => {
    const old = now - 40 * 86_400;
    net = mockFetch({
      'arbeitnow.com/api/job-board-api': {
        data: [job('a', { location: 'Amsterdam' }), job('b', { location: 'Amsterdam', created_at: old })],
        links: { next: 'https://www.arbeitnow.com/api/job-board-api?page=2' },
      },
    });
    const jobs = await BOARDS.arbeitnow();
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['arbeitnow:a'],
    );
    assert.equal(net.calls.length, 1);
  });
});

describe('adzuna', () => {
  const env = { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };
  afterEach(() => {
    for (const [k, v] of [
      ['ADZUNA_APP_ID', env.id],
      ['ADZUNA_APP_KEY', env.key],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const result = (id: string) => ({
    id,
    title: '<strong>Laravel</strong> Developer',
    company: { display_name: 'Acme BV' },
    location: { display_name: 'Zwolle, Overijssel', area: ['Nederland', 'Overijssel', 'Zwolle'] },
    description: 'Build APIs with <strong>Laravel</strong>…',
    redirect_url: `https://www.adzuna.nl/land/ad/${id}`,
    created: '2026-10-27T08:00:00Z',
  });

  it('is skipped with one log line when the keys are missing', async () => {
    delete process.env.ADZUNA_APP_ID;
    delete process.env.ADZUNA_APP_KEY;
    net = mockFetch({});
    const log = mock.method(console, 'log', () => {});
    try {
      assert.deepEqual(await BOARDS.adzuna(), []);
      assert.equal(log.mock.callCount(), 1);
      assert.match(String(log.mock.calls[0].arguments[0]), /adzuna: skipped .*ADZUNA_APP_ID/);
    } finally {
      log.mock.restore();
    }
    assert.equal(net.calls.length, 0);
  });

  it('searches nl per keyword, pages while pages are full, and maps the results', async () => {
    process.env.ADZUNA_APP_ID = 'test-id';
    process.env.ADZUNA_APP_KEY = 'test-key';
    net = mockFetch({
      'api.adzuna.com/v1/api/jobs/nl/search/': (url: string) => {
        const u = new URL(url);
        if (u.searchParams.get('what') !== 'laravel') return { results: [] };
        return u.pathname.endsWith('/1')
          ? { results: Array.from({ length: 50 }, (_, i) => result(String(i))) }
          : { results: [result('0'), result('99')] };
      },
    });
    const jobs = await BOARDS.adzuna();
    assert.equal(jobs.length, 51);
    const j = jobs[0];
    assert.equal(j.id, 'adzuna:nl:0');
    assert.equal(j.source, 'adzuna');
    assert.equal(j.title, 'Laravel Developer');
    assert.equal(j.company, 'Acme BV');
    assert.equal(j.location, 'Zwolle, Overijssel, Netherlands');
    assert.equal(j.description, 'Build APIs with Laravel …');
    assert.equal(j.url, 'https://www.adzuna.nl/land/ad/0');
    assert.equal(j.posted_at, '2026-10-27T08:00:00Z');
    const laravel = net.calls.filter((c) => new URL(c).searchParams.get('what') === 'laravel');
    assert.equal(laravel.length, 2);
    // Other keywords stop after an empty first page; the config's keywords are used (LinkedIn's by default).
    assert.equal(net.calls.length, 2 + (config.adzuna?.keywords ?? config.linkedin.keywords).length - 1);
    const q = new URL(net.calls[0]).searchParams;
    assert.deepEqual(
      [q.get('app_id'), q.get('app_key'), q.get('results_per_page'), q.get('max_days_old')],
      ['test-id', 'test-key', '50', String(config.maxAgeDays)],
    );
    assert.ok(net.calls.every((c) => !c.includes('/jobs/ae/')));
  });

  it('keeps the keys out of error messages', async () => {
    process.env.ADZUNA_APP_ID = 'secret-id';
    process.env.ADZUNA_APP_KEY = 'secret-key';
    net = mockFetch({ 'api.adzuna.com': () => new Response('', { status: 401 }) });
    const err = await BOARDS.adzuna().catch((e) => e);
    assert.match(err.message, /^401 /);
    assert.ok(!/secret-(id|key)/.test(err.message));
  });
});

describe('linkedin (guest search)', () => {
  const card = (id: string, title: string) => `<li><div data-entity-urn="urn:li:jobPosting:${id}">
    <h3 class="base-search-card__title">${title}</h3><h4 class="base-search-card__subtitle"><a>Acme &amp; Co</a></h4>
    <span class="job-search-card__location">Dubai, United Arab Emirates</span><time datetime="2026-10-27">1 day ago</time></div></li>`;

  it('parses cards, skips excluded titles before loading details, and labels remote searches', async () => {
    net = mockFetch({
      'seeMoreJobPostings/search': (url: string) =>
        new URL(url).searchParams.get('keywords') === 'laravel' ? card('111', 'Laravel Developer') + card('222', 'Sales Manager') : '',
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

  it('reads the "Base pay range" box as the salary; none when the job has no box', async () => {
    net = mockFetch({
      'seeMoreJobPostings/search': (url: string) =>
        new URL(url).searchParams.get('keywords') === 'laravel' ? card('111', 'Laravel Developer') + card('333', 'Node Developer') : '',
      // As on the real page: the wrapper's class also starts with "compensation__salary".
      'jobPosting/111': `<section class="compensation"><div class="compensation__salary-range">
        <h3 class="compensation__heading">Base pay range</h3>
        <div class="salary compensation__salary">
          $50.00/mo - $100.00/mo
        </div></div></section>
        <div class="show-more-less-html__markup">Build Laravel APIs</div>\n<button>`,
      'jobPosting/333': '<div class="show-more-less-html__markup">Node APIs, no pay stated</div>\n<button>',
    });
    const jobs = await linkedin();
    const byId = (id: string) => jobs.find((j) => j.id === id)!;
    assert.deepEqual(byId('linkedin:111').salary, { min: 50, max: 100, currency: 'USD', period: 'month' });
    assert.equal(byId('linkedin:333').salary, null);
  });

  it('stops LinkedIn for today on the first 429, without retrying', async () => {
    net = mockFetch({ linkedin: () => new Response('', { status: 429 }) });
    await assert.rejects(linkedin(), /429 LinkedIn rate limit: stopping LinkedIn for today/);
    assert.equal(net.calls.length, 1);
  });

  it('a 429 during the detail loop stops LinkedIn but keeps the details already fetched', async () => {
    net = mockFetch({
      'seeMoreJobPostings/search': (url: string) =>
        new URL(url).searchParams.get('keywords') === 'laravel'
          ? card('111', 'Laravel Developer') + card('333', 'PHP Developer') + card('444', 'Node Developer')
          : '',
      'jobPosting/111': '<div class="show-more-less-html__markup">Laravel</div>\n<button>',
      'jobPosting/333': () => new Response('', { status: 429 }),
      'jobPosting/444': '<div class="show-more-less-html__markup">Node</div>\n<button>',
    });
    const jobs = await linkedin();
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['linkedin:111'],
    );
    assert.match(jobs.partialError ?? '', /429 LinkedIn rate limit: stopping LinkedIn for today/);
    assert.equal(net.calls.filter((u) => u.includes('jobPosting/333')).length, 1); // no retry
    assert.ok(!net.calls.some((u) => u.includes('jobPosting/444')));
  });

  it('a detail that fails otherwise is skipped; the others are still fetched', async () => {
    net = mockFetch({
      'seeMoreJobPostings/search': (url: string) =>
        new URL(url).searchParams.get('keywords') === 'laravel' ? card('111', 'Laravel Developer') + card('333', 'PHP Developer') : '',
      'jobPosting/111': '<div class="show-more-less-html__markup">Laravel</div>\n<button>',
    });
    const jobs = await linkedin();
    assert.deepEqual(
      jobs.map((j) => j.id),
      ['linkedin:111'],
    );
    assert.match(jobs.partialError ?? '', /1 details failed \(first: 333: .*404/);
  });

  it('still retries a LinkedIn 5xx and keeps its browser headers', async () => {
    let n = 0;
    const agents: (string | undefined)[] = [];
    net = mockFetch({
      'seeMoreJobPostings/search': (_u: string, init?: RequestInit) => {
        agents.push((init?.headers as Record<string, string> | undefined)?.['user-agent']);
        return ++n === 1 ? new Response('', { status: 503 }) : '';
      },
    });
    await linkedin();
    assert.equal(net.calls[0], net.calls[1]);
    assert.match(agents[0] ?? '', /^Mozilla\//);
  });
});

describe('discover', () => {
  it('finds boards with jobs in target countries, best first', async () => {
    net = mockFetch({
      'boards-api.greenhouse.io/v1/boards/acme/': { jobs: [{ location: { name: 'Dubai' } }, { location: { name: 'London' } }] },
      'api.lever.co/v0/postings/acme': [{ categories: { location: 'Berlin' } }],
    });
    const hits = await discover(['acme']);
    assert.deepEqual(
      hits.map((h) => [h.ats, h.jobs, h.target]),
      [
        ['greenhouse', 2, 1],
        ['lever', 1, 0],
      ],
    );
  });

  it('probes each missing board once: a 404 is not retried', async () => {
    net = mockFetch({});
    assert.deepEqual(await discover(['nobody']), []);
    assert.equal(net.calls.length, 6);
    assert.equal(new Set(net.calls).size, 6);
  });
});

describe('discover: workday', () => {
  it('turns a myworkdayjobs URL into a token', () => {
    assert.equal(workdayToken('https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers/job/Dubai/Dev_R1'), 'acme/wd3/AcmeCareers');
    assert.equal(workdayToken('https://acme.wd103.myworkdayjobs.com/AcmeCareers'), 'acme/wd103/AcmeCareers');
    assert.equal(workdayToken('https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/AcmeCareers/jobs'), 'acme/wd3/AcmeCareers');
    assert.equal(workdayToken('acme'), null);
    assert.equal(workdayToken('https://acme.wd3.myworkdayjobs.com/'), null);
    assert.equal(workdayToken('https://example.com/AcmeCareers'), null);
  });

  it('probes only Workday for a Workday URL, and only the other boards for a name', async () => {
    net = mockFetch({
      'acme.wd3.myworkdayjobs.com/wday/cxs/acme/AcmeCareers/jobs': {
        total: 3,
        jobPostings: [
          { title: 'Dev', externalPath: '/job/a', locationsText: 'Dubai, UAE' },
          { title: 'Dev', externalPath: '/job/b', locationsText: 'London' },
          { title: 'Dev', externalPath: '/job/c', locationsText: '2 Locations' },
        ],
      },
    });
    const hits = await discover(['https://acme.wd3.myworkdayjobs.com/en-US/AcmeCareers', 'other']);
    assert.deepEqual(
      hits.map((h) => [h.slug, h.ats, h.jobs, h.target]),
      [['acme/wd3/AcmeCareers', 'workday', 3, 1]],
    );
    assert.equal(net.calls.filter((u) => u.includes('myworkdayjobs')).length, 1);
    assert.ok(!net.calls.some((u) => u.includes('myworkdayjobs') && u.includes('other')));
    assert.equal(net.calls.length, 7);
  });
});
