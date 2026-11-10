import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { daysAgo, mockFetch } from './helpers.ts';
import { fetch } from '../src/commands/fetch.ts';
import { config } from '../src/config.ts';
import { timing } from '../src/sources/http.ts';
import { dedupe, getJob, migrate, pool, pruneFiltered, setStatus, upsertJob, type ScoredJob } from '../src/db.ts';
import { saveAgain } from '../src/commands/fetch.ts';
import { indFile, isIndSponsor } from '../src/sponsors.ts';
import { dataDir } from '../src/settings.ts';

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

// A small IND register in the test data dir (tests/helpers.ts JOB_BOT_DATA_DIR), never the downloaded one in data/.
mkdirSync(dataDir(), { recursive: true });
writeFileSync(indFile(), JSON.stringify({ updated: new Date().toISOString(), names: ['Adyen B.V.', 'elasticsearch B.V.'] }));

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

  it('logs the applied_at from before each change (prev_applied_at), so an undo can put it back', async () => {
    await upsertJob(job());
    const legacy = new Date('2026-01-05T10:00:00Z');
    await pool.query(`UPDATE jobs SET status = 'applied', applied_at = $1 WHERE id = 'test:db1'`, [legacy]);
    await setStatus('test:db1', 'interview');
    await setStatus('test:db1', 'applied');
    const stamped = (await getJob('test:db1')).applied_at;
    assert.notDeepEqual(stamped, legacy);
    await setStatus('test:db1', 'rejected');
    const { rows } = await pool.query('SELECT to_status, prev_applied_at FROM job_events ORDER BY id');
    assert.deepEqual(rows, [
      { to_status: 'interview', prev_applied_at: legacy },
      { to_status: 'applied', prev_applied_at: legacy },
      { to_status: 'rejected', prev_applied_at: stamped },
    ]);
  });

  it('logs a NULL prev_applied_at for a job never applied to', async () => {
    await upsertJob(job());
    await setStatus('test:db1', 'applied');
    assert.equal((await pool.query('SELECT prev_applied_at FROM job_events')).rows[0].prev_applied_at, null);
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

describe('setStatus extra columns (set)', () => {
  it('carries filter_reason in the same transaction as the status change, and clears it the same way', async () => {
    await upsertJob(job());
    assert.equal(
      await setStatus('test:db1', 'filtered', 'location (AI): US only', undefined, {
        expectFrom: ['new'],
        set: { filter_reason: 'location (AI): US only' },
      }),
      true,
    );
    let j = await getJob('test:db1');
    assert.deepEqual([j.status, j.filter_reason], ['filtered', 'location (AI): US only']);
    assert.equal(
      await setStatus('test:db1', 'new', 'location (AI) passed', undefined, { expectFrom: ['filtered'], set: { filter_reason: null } }),
      true,
    );
    j = await getJob('test:db1');
    assert.deepEqual([j.status, j.filter_reason], ['new', null]);
  });

  it('a change refused by expectFrom touches neither the status nor the extra columns', async () => {
    await upsertJob(job());
    await setStatus('test:db1', 'applied');
    assert.equal(
      await setStatus('test:db1', 'filtered', 'x', undefined, { expectFrom: ['new'], set: { filter_reason: 'location (AI): x' } }),
      false,
    );
    const j = await getJob('test:db1');
    assert.deepEqual([j.status, j.filter_reason], ['applied', null]);
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
    assert.equal((await dedupe()).grouped, 1);
    assert.equal((await getJob('li:1')).duplicate_of, 'gh:1');
    assert.equal((await getJob('other')).duplicate_of, null);

    await pool.query(`UPDATE jobs SET title = 'Data Engineer' WHERE id = 'li:1'`);
    assert.equal((await dedupe()).grouped, 0);
    assert.equal((await getJob('li:1')).duplicate_of, null);
  });

  it('ignores filtered jobs', async () => {
    await upsertJob(job({ id: 'gh:1' }));
    await upsertJob(job({ id: 'li:1', source: 'linkedin', status: 'filtered', filter_reason: 'x' }));
    assert.equal((await dedupe()).grouped, 0);
  });

  it('two dedupes at once leave every duplicate grouped', async () => {
    await upsertJob(job({ id: 'gh:1' }));
    await upsertJob(job({ id: 'li:1', source: 'linkedin' }));
    await upsertJob(job({ id: 'bayt:1', source: 'bayt' }));
    await dedupe(); // links exist, so the concurrent runs both check the same rows
    const [a, b] = await Promise.all([dedupe(), dedupe()]);
    assert.deepEqual([a.grouped, b.grouped], [2, 2]);
    assert.equal((await getJob('li:1')).duplicate_of, 'gh:1');
    assert.equal((await getJob('bayt:1')).duplicate_of, 'gh:1');
  });

  // xmin is the id of the transaction that last wrote a row: unchanged means dedupe did not rewrite it.
  const versions = () => pool.query<{ id: string; xmin: string }>('SELECT id, xmin::text FROM jobs ORDER BY id').then((r) => r.rows);

  it('an unchanged grouping updates no rows', async () => {
    await upsertJob(job({ id: 'gh:1' }));
    await upsertJob(job({ id: 'li:1', source: 'linkedin' }));
    await upsertJob(job({ id: 'bayt:1', source: 'bayt' }));
    await upsertJob(job({ id: 'other', title: 'Frontend Engineer' }));
    assert.deepEqual(await dedupe(), { grouped: 2, changed: 2 });
    const before = await versions();
    assert.deepEqual(await dedupe(), { grouped: 2, changed: 0 }, 'nothing to write, and nothing for the CLI to say');
    assert.deepEqual(await versions(), before);
    assert.equal((await getJob('li:1')).duplicate_of, 'gh:1');
  });

  it('only rewrites the rows whose link changed, and clears a copy that left its group', async () => {
    await upsertJob(job({ id: 'gh:1' }));
    await upsertJob(job({ id: 'li:1', source: 'linkedin' }));
    await upsertJob(job({ id: 'bayt:1', source: 'bayt' }));
    await dedupe();
    const before = new Map((await versions()).map((r) => [r.id, r.xmin]));
    await pool.query(`UPDATE jobs SET status = 'filtered', filter_reason = 'x' WHERE id = 'bayt:1'`);
    const filteredAt = (await versions()).find((r) => r.id === 'bayt:1')!.xmin;
    assert.equal((await dedupe()).grouped, 1);
    assert.equal((await getJob('bayt:1')).duplicate_of, null);
    const after = new Map((await versions()).map((r) => [r.id, r.xmin]));
    assert.equal(after.get('gh:1'), before.get('gh:1'));
    assert.equal(after.get('li:1'), before.get('li:1'));
    assert.notEqual(after.get('bayt:1'), filteredAt);
  });
});

describe('IND sponsor register', () => {
  it('knows recognised sponsors and uses indName from config', () => {
    assert.ok(indFile().startsWith(dataDir()), 'the register is read from the data dir');
    assert.equal(isIndSponsor('Adyen'), true);
    assert.equal(isIndSponsor('Elastic'), true); // config maps it to "elasticsearch B.V."
    assert.equal(isIndSponsor('Totally Unknown Startup Xyz'), false);
    assert.equal(isIndSponsor('A'), false);
    // A company list passed in replaces config.json's: without the mapping, "Elastic" is not on the register.
    assert.equal(isIndSponsor('Elastic', []), false);
    assert.equal(isIndSponsor('Acme', [{ name: 'Acme', indName: 'Adyen' }]), true);
  });
});

describe('fetched_at', () => {
  const age = (id: string) =>
    pool
      .query<{ days: number }>(`SELECT round(extract(epoch FROM now() - fetched_at) / 86400)::int days FROM jobs WHERE id = $1`, [id])
      .then((r) => r.rows[0].days);

  it('a fetch (upsert) moves it; rescore (saveAgain) and seen: false leave it alone', async () => {
    await upsertJob(job());
    await pool.query(`UPDATE jobs SET fetched_at = now() - interval '5 days'`);
    await saveAgain(await getJob('test:db1'));
    assert.equal(await age('test:db1'), 5);
    await upsertJob(job({ seen: false, title: 'Changed' }));
    assert.equal(await age('test:db1'), 5);
    assert.equal((await getJob('test:db1')).title, 'Changed');
    await upsertJob(job());
    assert.equal(await age('test:db1'), 0);
  });
});

describe('pruneFiltered', () => {
  const old = { status: 'filtered' as const, filter_reason: 'posted 99 days ago', posted_at: daysAgo(100) };
  /** A filtered posting, its dates set as given (days ago). */
  async function add(id: string, o: Partial<ScoredJob> = {}, dates: { firstSeen?: number; fetched?: number } = {}) {
    await upsertJob(job({ id, url: `https://x/${id}`, ...old, ...o }));
    await pool.query(
      `UPDATE jobs SET first_seen_at = now() - make_interval(days => $2::int), fetched_at = now() - make_interval(days => $3::int)
       WHERE id = $1`,
      [id, dates.firstSeen ?? 100, dates.fetched ?? 10],
    );
  }
  const ids = async () => (await pool.query<{ id: string }>('SELECT id FROM jobs ORDER BY id')).rows.map((r) => r.id);

  it('deletes only old, unseen filtered postings without history, contacts, tasks or copies', async () => {
    await add('p:old');
    await add('p:old-undated', { posted_at: null });
    await add('p:recent', { posted_at: daysAgo(10) });
    await add('p:recent-undated', { posted_at: null }, { firstSeen: 10 });
    await add('p:still-listed', {}, { fetched: 1 });
    await add('p:new', { status: 'new', filter_reason: null });
    await add('p:event');
    await setStatus('p:event', 'filtered', 'kept for its history');
    await add('p:contact');
    await pool.query(`INSERT INTO contacts (job_id, name) VALUES ('p:contact', 'Recruiter')`);
    await add('p:task');
    await pool.query(`INSERT INTO tasks (kind, job_id, status) VALUES ('prepare', 'p:task', 'done')`);
    await add('p:primary');
    await add('p:copy', { status: 'new', filter_reason: null });
    await pool.query(`UPDATE jobs SET duplicate_of = 'p:primary' WHERE id = 'p:copy'`);

    assert.equal(await pruneFiltered(14), 2);
    assert.deepEqual(await ids(), [
      'p:contact',
      'p:copy',
      'p:event',
      'p:new',
      'p:primary',
      'p:recent',
      'p:recent-undated',
      'p:still-listed',
      'p:task',
    ]);
  });

  it('keeps postings for twice maxAgeDays when that is longer than 30 days', async () => {
    await add('p:100', { posted_at: daysAgo(100) });
    await add('p:130', { posted_at: daysAgo(130) });
    assert.equal(await pruneFiltered(60), 1); // cutoff 120 days
    assert.deepEqual(await ids(), ['p:100']);
    assert.equal(await pruneFiltered(14), 1); // cutoff 30 days
    assert.deepEqual(await ids(), []);
  });
});

describe('the pool is created on first use', () => {
  it('importing db.ts without DATABASE_URL works; the first query throws the one-line UserError', async () => {
    const root = join(import.meta.dirname, '..');
    const script = `
      const { pool, getPool } = await import('./src/db.ts');
      const { UserError } = await import('./src/errors.ts');
      await pool.end(); // never created: a no-op, so a finally after a failed start does not hide the first error
      for (const f of [() => pool.query('SELECT 1'), () => getPool()]) {
        try { await f(); console.log('no error'); } catch (e) { console.log(e instanceof UserError, e.message); }
      }`;
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
      cwd: root,
      env,
      timeout: 30_000,
    });
    const line = 'true DATABASE_URL is not set: put it in .env in the job-bot folder';
    assert.deepEqual(stdout.trim().split('\n'), [line, line]);
  });
});
