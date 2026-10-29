import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { daysAgo, mockFetch } from './helpers.ts';
import { fetch } from '../src/commands/fetch.ts';
import { config } from '../src/config.ts';
import { timing } from '../src/sources/http.ts';
import { dedupe, getJob, migrate, pool, setStatus, upsertJob, type ScoredJob } from '../src/db.ts';
import { isIndSponsor } from '../src/sponsors.ts';

const job = (o: Partial<ScoredJob> = {}): ScoredJob => ({
  id: 'test:db1',
  source: 'greenhouse',
  company: 'Acme',
  title: 'Backend Engineer',
  location: 'Dubai',
  country: 'AE',
  url: 'https://x/1',
  description: 'Node',
  posted_at: '2026-10-27T00:00:00Z',
  score: 80,
  cluster: 'default',
  matched: ['Node.js'],
  missing: [],
  visa: 'UAE',
  flags: [],
  status: 'new',
  filter_reason: null,
  ...o,
});

before(migrate);
beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
after(() => pool.end());

describe('schema', () => {
  it('migrate is idempotent', async () => {
    await migrate();
    await migrate();
  });
});

describe('upsertJob', () => {
  it('inserts, then updates the posting on the next fetch', async () => {
    assert.equal(await upsertJob(job()), 'inserted');
    assert.equal(await upsertJob(job({ title: 'Senior Backend Engineer', score: 90 })), 'updated');
    const j = await getJob('test:db1');
    assert.equal(j.title, 'Senior Backend Engineer');
    assert.equal(j.score, 90);
    assert.deepEqual(j.form_answers, []);
  });

  it('moves a job between new and filtered while untouched', async () => {
    await upsertJob(job());
    await upsertJob(job({ status: 'filtered', filter_reason: 'too old' }));
    assert.equal((await getJob('test:db1')).status, 'filtered');
  });

  it('never overwrites the status, CV or notes once the user acted', async () => {
    await upsertJob(job());
    await setStatus('test:db1', 'applied');
    await pool.query(`UPDATE jobs SET notes = 'called HR', cv_version = 'laravel-v1' WHERE id = 'test:db1'`);
    await upsertJob(job({ status: 'filtered', filter_reason: 'posted 20 days ago' }));
    const j = await getJob('test:db1');
    assert.equal(j.status, 'applied');
    assert.equal(j.notes, 'called HR');
    assert.equal(j.cv_version, 'laravel-v1');
  });
});

describe('setStatus', () => {
  it('records history and the applied date, without touching notes', async () => {
    await upsertJob(job());
    await setStatus('test:db1', 'prepared', 'CV: default');
    await setStatus('test:db1', 'applied');
    const j = await getJob('test:db1');
    assert.ok(j.applied_at);
    assert.equal(j.notes, null);
    const { rows } = await pool.query('SELECT from_status, to_status, note FROM job_events ORDER BY id');
    assert.deepEqual(rows, [
      { from_status: 'new', to_status: 'prepared', note: 'CV: default' },
      { from_status: 'prepared', to_status: 'applied', note: null },
    ]);
  });
});

describe('setStatus expectFrom', () => {
  const statusOf = async () => (await getJob('test:db1')).status;
  const eventCount = async () => (await pool.query('SELECT count(*)::int n FROM job_events')).rows[0].n;

  it('applies the change when the current status is one of expectFrom', async () => {
    await upsertJob(job());
    assert.equal(await setStatus('test:db1', 'expired', 'posting closed', undefined, { expectFrom: ['new', 'prepared'] }), true);
    assert.equal(await statusOf(), 'expired');
    assert.equal(await eventCount(), 1);
  });

  it('a status set between the read and the write wins: no update, no history entry', async () => {
    await upsertJob(job());
    // The bot read 'new'; the user marks it applied before the bot writes.
    await setStatus('test:db1', 'applied');
    const appliedAt = (await getJob('test:db1')).applied_at;
    assert.equal(await setStatus('test:db1', 'expired', 'posting closed', undefined, { expectFrom: ['new', 'prepared'] }), false);
    const j = await getJob('test:db1');
    assert.equal(j.status, 'applied');
    assert.deepEqual(j.applied_at, appliedAt);
    assert.equal(await eventCount(), 1);
  });

  it('returns false for a missing job, and a change without expectFrom (mark) always applies', async () => {
    assert.equal(await setStatus('test:nope', 'expired', undefined, undefined, { expectFrom: ['new'] }), false);
    assert.equal(await eventCount(), 0);
    await upsertJob(job());
    await setStatus('test:db1', 'applied');
    assert.equal(await setStatus('test:db1', 'rejected'), true);
    assert.equal(await statusOf(), 'rejected');
  });
});

describe('fetch', () => {
  const saved = { companies: config.companies, remote: config.remote.enabled, linkedin: config.linkedin.enabled };
  let net: ReturnType<typeof mockFetch> | undefined;
  let log: ReturnType<typeof mock.method> | undefined;
  beforeEach(() => {
    timing.scale = 0;
    config.remote.enabled = false;
    config.linkedin.enabled = false;
    log = mock.method(console, 'log', () => {});
  });
  afterEach(() => {
    net?.restore();
    log?.mock.restore();
    Object.assign(config, { companies: saved.companies });
    config.remote.enabled = saved.remote;
    config.linkedin.enabled = saved.linkedin;
  });
  const gh = (id: number, o: Record<string, unknown> = {}) => ({
    id,
    title: 'Senior Backend Engineer',
    location: { name: 'Dubai, UAE' },
    absolute_url: `https://x/${id}`,
    content: 'Node, TypeScript, PostgreSQL',
    first_published: new Date().toISOString(),
    ...o,
  });
  const lastRun = async () => (await pool.query('SELECT checked, inserted, errors FROM fetch_runs ORDER BY id DESC LIMIT 1')).rows[0];

  it('saves postings one by one: a posting the database rejects is skipped, the rest are saved', async () => {
    config.companies = [{ name: 'Acme', ats: 'greenhouse', token: 'acme' }];
    net = mockFetch({ 'boards/acme/jobs': { jobs: [gh(1), gh(2, { first_published: 'not a date' }), gh(3)] } });
    await fetch([], {});
    const { rows } = await pool.query('SELECT id FROM jobs ORDER BY id');
    assert.deepEqual(
      rows.map((r) => r.id),
      ['greenhouse:acme:1', 'greenhouse:acme:3'],
    );
    const run = await lastRun();
    assert.deepEqual([run.checked, run.inserted], [2, 2]);
    assert.equal(run.errors.length, 1);
    assert.equal(run.errors[0].company, 'Acme');
    assert.match(run.errors[0].error, /^1 of 3 postings not saved \(first: greenhouse:acme:2: /);
  });

  it("saves a source's partial result and records its partial error", async () => {
    config.companies = [{ name: 'Sr', ats: 'smartrecruiters', token: 'sr' }];
    const p = (id: string) => ({
      id,
      name: 'Senior Backend Engineer',
      location: { fullLocation: 'Riyadh, Saudi Arabia' },
      releasedDate: daysAgo(1),
    });
    net = mockFetch({
      'postings?limit=100': { totalFound: 2, content: [p('p1'), p('p2')] },
      'postings/p1': { postingUrl: 'https://s/p1', jobAd: { sections: { a: { text: 'Node' } } } },
    });
    await fetch([], {});
    assert.ok(await getJob('smartrecruiters:sr:p1'));
    const run = await lastRun();
    assert.equal(run.inserted, 1);
    assert.equal(run.errors.length, 1);
    assert.match(run.errors[0].error, /^partial: kept 1 postings; 1 of 2 details failed \(first: p2: .*404/);
  });
});

describe('dedupe', () => {
  it('points copies at the primary and resets old links', async () => {
    await upsertJob(job({ id: 'gh:1' }));
    await upsertJob(job({ id: 'li:1', source: 'linkedin', company: 'Acme Inc' }));
    await upsertJob(job({ id: 'other', title: 'Frontend Engineer' }));
    assert.equal(await dedupe(), 1);
    assert.equal((await getJob('li:1')).duplicate_of, 'gh:1');
    assert.equal((await getJob('other')).duplicate_of, null);

    await pool.query(`UPDATE jobs SET title = 'Data Engineer' WHERE id = 'li:1'`);
    assert.equal(await dedupe(), 0);
    assert.equal((await getJob('li:1')).duplicate_of, null);
  });

  it('ignores filtered jobs', async () => {
    await upsertJob(job({ id: 'gh:1' }));
    await upsertJob(job({ id: 'li:1', source: 'linkedin', status: 'filtered', filter_reason: 'x' }));
    assert.equal(await dedupe(), 0);
  });
});

describe('IND sponsor register', () => {
  it('knows recognised sponsors and uses indName from config', () => {
    const known = isIndSponsor('Adyen');
    if (known === null) return; // register not downloaded on this machine
    assert.equal(known, true);
    assert.equal(isIndSponsor('Elastic'), true); // config maps it to "elasticsearch B.V."
    assert.equal(isIndSponsor('Totally Unknown Startup Xyz'), false);
    assert.equal(isIndSponsor('A'), false);
  });
});
