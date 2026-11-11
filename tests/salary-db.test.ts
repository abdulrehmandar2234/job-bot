import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch, raw } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { save } from '../src/commands/shared.ts';
import { rescore } from '../src/commands/fetch.ts';
import { timing } from '../src/sources/http.ts';
import { fetchCompany } from '../src/sources/index.ts';
import { BOARDS } from '../src/sources/boards.ts';
import { config } from '../src/config.ts';

const salaryOf = async (id: string) => {
  const j = await getJob(id);
  return [j.salary_min, j.salary_max, j.salary_currency, j.salary_period];
};
const AED_MONTH = 'We use Laravel, PHP, React, Node.js and TypeScript. Salary: AED 20,000 - 25,000 per month.';

const cacheDir = mkdtempSync(join(tmpdir(), 'talaash-salary-'));
before(async () => {
  await migrate();
  timing.scale = 0;
  process.env.JOB_BOT_HTTP_CACHE = cacheDir;
});
beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
after(async () => {
  await pool.end();
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('save() and salary', () => {
  it('parses the salary from the description and stores it', async () => {
    await save(raw({ description: AED_MONTH }));
    assert.deepEqual(await salaryOf('test:1'), [20_000, 25_000, 'AED', 'month']);
  });

  it('stores nulls when the posting names no salary, and clears an old one on the next fetch', async () => {
    await save(raw({ description: AED_MONTH }));
    await save(raw());
    assert.deepEqual(await salaryOf('test:1'), [null, null, null, null]);
  });

  it("prefers the source's own salary over the text", async () => {
    await save(raw({ description: AED_MONTH, salary: { min: 300_000, max: null, currency: 'AED', period: 'year' } }));
    assert.deepEqual(await salaryOf('test:1'), [300_000, null, 'AED', 'year']);
  });

  it('reads "Rs" as INR for a job in India and as PKR elsewhere', async () => {
    const RS = 'We use Laravel, PHP, React and Node.js. Salary: Rs. 350,000 per month.';
    config.countries.IN = { name: 'India', visa: 'employer', match: 'bengaluru|\\bindia\\b' };
    try {
      await save(raw({ id: 'test:in', location: 'Bengaluru, India', description: RS }));
      await save(raw({ id: 'test:ae', url: 'https://example.com/2', description: RS }));
    } finally {
      delete config.countries.IN;
    }
    assert.equal((await getJob('test:in')).country, 'IN');
    assert.deepEqual(await salaryOf('test:in'), [350_000, 350_000, 'INR', 'month']);
    assert.deepEqual(await salaryOf('test:ae'), [350_000, 350_000, 'PKR', 'month']);
  });
});

describe('rescore and salary', () => {
  const quiet = () => mock.method(console, 'log', () => {});

  it('backfills existing rows, including jobs the user already acted on', async () => {
    await save(raw({ id: 'test:new', description: AED_MONTH }));
    await save(raw({ id: 'test:applied', url: 'https://example.com/2', description: AED_MONTH }));
    await pool.query(
      `UPDATE jobs SET status = 'applied', salary_min = NULL, salary_max = NULL, salary_currency = NULL, salary_period = NULL`,
    );
    await pool.query(`UPDATE jobs SET status = 'new' WHERE id = 'test:new'`);
    const log = quiet();
    try {
      await rescore();
    } finally {
      log.mock.restore();
    }
    assert.deepEqual(await salaryOf('test:new'), [20_000, 25_000, 'AED', 'month']);
    assert.deepEqual(await salaryOf('test:applied'), [20_000, 25_000, 'AED', 'month']);
    assert.equal((await getJob('test:applied')).status, 'applied');
  });

  it("re-reads a stored job's lakh amounts in rupees from its country", async () => {
    await save(raw({ id: 'test:applied', description: 'Laravel and React. CTC: 15-20 lakhs.' }));
    await pool.query(`UPDATE jobs SET status = 'applied', country = 'IN'`);
    const log = quiet();
    try {
      await rescore();
    } finally {
      log.mock.restore();
    }
    assert.deepEqual(await salaryOf('test:applied'), [1_500_000, 2_000_000, 'INR', 'year']);
  });

  it('keeps a structured salary from an API source that the text does not repeat', async () => {
    await save(
      raw({
        id: 'remoteok:1',
        source: 'remoteok',
        location: 'Remote — Worldwide',
        salary: { min: 90_000, max: 120_000, currency: 'USD', period: 'year' },
      }),
    );
    await save(raw({ id: 'greenhouse:x:1', url: 'https://example.com/3' }));
    await pool.query(
      `UPDATE jobs SET salary_min = 1, salary_max = 2, salary_currency = 'USD', salary_period = 'year' WHERE id = 'greenhouse:x:1'`,
    );
    const log = quiet();
    try {
      await rescore();
    } finally {
      log.mock.restore();
    }
    assert.deepEqual(await salaryOf('remoteok:1'), [90_000, 120_000, 'USD', 'year']);
    // A parsed source is re-parsed, so a stale value goes away.
    assert.deepEqual(await salaryOf('greenhouse:x:1'), [null, null, null, null]);
  });
});

describe('structured salary from sources', () => {
  let net: ReturnType<typeof mockFetch>;
  afterEach(() => net?.restore());

  it('remoteok: yearly USD, none when the fields are 0', async () => {
    net = mockFetch({
      'remoteok.com/api': [
        { legal: 'notice' },
        {
          id: 1,
          position: 'React Dev',
          company: 'B',
          location: 'Worldwide',
          url: 'u',
          description: 'x',
          salary_min: 80000,
          salary_max: 100000,
        },
        { id: 2, position: 'Node Dev', company: 'C', location: 'Worldwide', url: 'u', description: 'x', salary_min: 0, salary_max: 0 },
      ],
    });
    const jobs = await BOARDS.remoteok();
    assert.deepEqual(
      jobs.map((j) => j.salary),
      [{ min: 80_000, max: 100_000, currency: 'USD', period: 'year' }, null],
    );
  });

  it('himalayas: min/max with the given currency', async () => {
    const now = Math.floor(Date.now() / 1000);
    net = mockFetch({
      'himalayas.app/jobs/api/search': (url: string) =>
        url.includes('page=1')
          ? {
              jobs: [
                {
                  guid: `https://himalayas.app/companies/a/jobs/${url.length}`,
                  companyName: 'A',
                  title: 'Dev',
                  pubDate: now,
                  description: 'x',
                  minSalary: 60000,
                  maxSalary: 75000,
                  currency: 'EUR',
                },
              ],
            }
          : { jobs: [] },
    });
    const [j] = await BOARDS.himalayas();
    assert.deepEqual(j.salary, { min: 60_000, max: 75_000, currency: 'EUR', period: 'year' });
  });

  it('lever: salaryRange with its interval', async () => {
    net = mockFetch({
      'api.lever.co': [
        {
          id: 'a',
          text: 'Dev',
          categories: {},
          hostedUrl: 'h',
          salaryRange: { min: 15000, max: 20000, currency: 'AED', interval: 'per-month-salary' },
        },
        { id: 'b', text: 'Dev', categories: {}, hostedUrl: 'h' },
      ],
    });
    const jobs = await fetchCompany({ name: 'Acme', ats: 'lever', token: 'acme' });
    assert.deepEqual(
      jobs.map((j) => j.salary),
      [{ min: 15_000, max: 20_000, currency: 'AED', period: 'month' }, null],
    );
  });

  it('adzuna: yearly INR for in', async () => {
    const env = { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };
    const saved = config.adzuna;
    process.env.ADZUNA_APP_ID = 'id';
    process.env.ADZUNA_APP_KEY = 'key';
    config.adzuna = { ...saved, countries: ['in'], keywords: ['laravel'], pagesPerSearch: 1 };
    net = mockFetch({
      'api.adzuna.com/v1/api/jobs/in/search/1': {
        results: [
          {
            id: '1',
            title: 'Laravel Developer',
            company: { display_name: 'A' },
            description: 'x',
            redirect_url: 'https://a/1',
            created: '2026-10-27T08:00:00Z',
            salary_min: 1200000,
            salary_max: 1800000,
            salary_is_predicted: '0',
          },
        ],
      },
    });
    try {
      const jobs = await BOARDS.adzuna();
      assert.deepEqual(
        jobs.map((j) => j.salary),
        [{ min: 1_200_000, max: 1_800_000, currency: 'INR', period: 'year' }],
      );
    } finally {
      config.adzuna = saved;
      process.env.ADZUNA_APP_ID = env.id ?? '';
      process.env.ADZUNA_APP_KEY = env.key ?? '';
      if (env.id === undefined) delete process.env.ADZUNA_APP_ID;
      if (env.key === undefined) delete process.env.ADZUNA_APP_KEY;
    }
  });

  it("adzuna: yearly EUR for nl, skipping Adzuna's own estimates", async () => {
    const env = { id: process.env.ADZUNA_APP_ID, key: process.env.ADZUNA_APP_KEY };
    process.env.ADZUNA_APP_ID = 'id';
    process.env.ADZUNA_APP_KEY = 'key';
    const ad = (id: string, o: object) => ({
      id,
      title: 'Laravel Developer',
      company: { display_name: 'A' },
      description: 'x',
      redirect_url: `https://a/${id}`,
      created: '2026-10-27T08:00:00Z',
      ...o,
    });
    net = mockFetch({
      'api.adzuna.com': (url: string) =>
        new URL(url).searchParams.get('what') === 'laravel' && url.includes('/search/1?')
          ? {
              results: [
                ad('1', { salary_min: 55000, salary_max: 70000, salary_is_predicted: '0' }),
                ad('2', { salary_min: 50000, salary_max: 50000, salary_is_predicted: '1' }),
              ],
            }
          : { results: [] },
    });
    try {
      const jobs = await BOARDS.adzuna();
      assert.deepEqual(
        jobs.map((j) => j.salary),
        [{ min: 55_000, max: 70_000, currency: 'EUR', period: 'year' }, null],
      );
    } finally {
      process.env.ADZUNA_APP_ID = env.id ?? '';
      process.env.ADZUNA_APP_KEY = env.key ?? '';
      if (env.id === undefined) delete process.env.ADZUNA_APP_ID;
      if (env.key === undefined) delete process.env.ADZUNA_APP_KEY;
    }
  });
});
