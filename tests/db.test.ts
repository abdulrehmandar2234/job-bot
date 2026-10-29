import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts';
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
