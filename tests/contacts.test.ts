import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { migrate, pool, setStatus, upsertJob, type ScoredJob } from '../src/db.ts';
import { path } from '../src/config.ts';
import { isLinkedinUrl, validateContact } from '../src/commands/contacts.ts';

// Contacts per job (migration 005), the skip reason on job_events, and the contacts / contact:add / mark --reason CLI.
const FAKE = new URL('./fixtures/fake-claude.mjs', import.meta.url).pathname;
const run = promisify(execFile);
const bot = async (args: string[]) => {
  try {
    return (
      await run(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], {
        cwd: path(),
        env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE },
        timeout: 60_000,
      })
    ).stdout;
  } catch (e) {
    return (e as { stdout: string }).stdout; // contact:add exits 1 on invalid input
  }
};

const job = (o: Partial<ScoredJob> = {}): ScoredJob => ({
  id: 'test:c1',
  source: 'greenhouse',
  company: 'Acme Inc.',
  title: 'Backend Engineer',
  location: 'Dubai',
  country: 'AE',
  url: 'https://x/1',
  description: 'Node',
  posted_at: '2026-10-27T00:00:00Z',
  score: 80,
  cluster: 'default',
  matched: [],
  missing: [],
  visa: null,
  flags: [],
  status: 'new',
  filter_reason: null,
  ...o,
});
const contactRows = async () => (await pool.query('SELECT * FROM contacts ORDER BY id')).rows;

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE');
  await upsertJob(job());
});
after(() => pool.end());

describe('migration 005', () => {
  it('stores a contact with defaults and deletes it with its job', async () => {
    await pool.query(`INSERT INTO contacts (job_id, name) VALUES ('test:c1', 'Jane')`);
    const [c] = await contactRows();
    assert.equal(c.role, 'other');
    assert.equal(c.referral_status, 'none');
    assert.ok(c.created_at instanceof Date);
    await pool.query(`DELETE FROM jobs WHERE id = 'test:c1'`);
    assert.deepEqual(await contactRows(), []);
  });

  it('rejects unknown roles, referral statuses, skip reasons and jobs', async () => {
    await assert.rejects(pool.query(`INSERT INTO contacts (job_id, name, role) VALUES ('test:c1', 'J', 'boss')`), /check/);
    await assert.rejects(pool.query(`INSERT INTO contacts (job_id, name, referral_status) VALUES ('test:c1', 'J', 'maybe')`), /check/);
    await assert.rejects(pool.query(`INSERT INTO contacts (job_id, name) VALUES ('test:nope', 'J')`), /foreign key/);
    await assert.rejects(
      pool.query(`INSERT INTO job_events (job_id, to_status, reason) VALUES ('test:c1', 'skipped', 'boredom')`),
      /check/,
    );
  });
});

describe('setStatus reason', () => {
  it('keeps the reason on a skip, in the same history row', async () => {
    await setStatus('test:c1', 'skipped', 'php 5', 'stack');
    const { rows } = await pool.query('SELECT from_status, to_status, note, reason FROM job_events');
    assert.deepEqual(rows, [{ from_status: 'new', to_status: 'skipped', note: 'php 5', reason: 'stack' }]);
  });

  it('drops a reason on any other status, and defaults to null', async () => {
    await setStatus('test:c1', 'applied', undefined, 'salary');
    await setStatus('test:c1', 'rejected');
    const { rows } = await pool.query('SELECT reason FROM job_events');
    assert.deepEqual(
      rows.map((r) => r.reason),
      [null, null],
    );
  });
});

describe('validateContact', () => {
  it('trims, defaults and nulls empty optional fields', () => {
    assert.deepEqual(validateContact({ name: '  Jane Doe ', email: ' ', role: 'recruiter' }), {
      contact: { name: 'Jane Doe', role: 'recruiter', email: null, linkedin_url: null, phone: null, notes: null, referral_status: 'none' },
    });
  });

  it('rejects bad input with one message per field', () => {
    const r = validateContact({
      name: 'x'.repeat(121),
      role: 'boss',
      referral_status: 'maybe',
      email: 'not-an-email',
      linkedin_url: 'http://linkedin.com/in/x',
      phone: 'call me',
      notes: 'n'.repeat(2001),
    });
    assert.ok('errors' in r);
    assert.equal(r.errors.length, 7);
    assert.deepEqual(validateContact({}), { errors: ['name is required'] });
  });

  it('accepts only https linkedin.com URLs', () => {
    assert.ok(isLinkedinUrl('https://www.linkedin.com/in/jane'));
    assert.ok(isLinkedinUrl('https://ae.linkedin.com/in/jane'));
    for (const bad of [
      'http://linkedin.com/in/x',
      'https://linkedin.com.evil.io/x',
      'https://evil.io/linkedin.com',
      'javascript:alert(1)',
      'jane',
    ]) {
      assert.equal(isLinkedinUrl(bad), false, bad);
    }
  });
});

describe('CLI', () => {
  it('contact:add stores a contact and contacts lists it', async () => {
    const out = await bot([
      'contact:add',
      'test:c1',
      '--name',
      'Jane Doe',
      '--role',
      'hiring manager',
      '--email',
      'jane@acme.com',
      '--linkedin',
      'https://www.linkedin.com/in/jane',
      '--referral',
      'to ask',
    ]);
    assert.match(out, /Added contact #\d+ Jane Doe \(hiring manager\) to Acme Inc\. — Backend Engineer/);
    const [c] = await contactRows();
    assert.equal(c.email, 'jane@acme.com');
    assert.equal(c.referral_status, 'to ask');
    const list = await bot(['contacts', 'test:c1']);
    assert.match(list, /Jane Doe \(hiring manager\) · referral: to ask/);
    assert.match(list, /https:\/\/www\.linkedin\.com\/in\/jane/);
  });

  it('contact:add refuses invalid input and unknown jobs', async () => {
    assert.match(await bot(['contact:add', 'test:c1', '--name', '--email', 'bad']), /Not added:\n {2}- name is required\n {2}- email/);
    assert.match(await bot(['contact:add', 'test:nope', '--name', 'X']), /Usage: contact:add/);
    assert.deepEqual(await contactRows(), []);
  });

  it('contacts shows people you know at the same company from other jobs', async () => {
    await upsertJob(job({ id: 'test:c2', company: 'ACME', title: 'Frontend Engineer', url: 'https://x/2' }));
    await upsertJob(job({ id: 'test:c3', company: 'Other Co', url: 'https://x/3' }));
    await pool.query(`INSERT INTO contacts (job_id, name) VALUES ('test:c2', 'Sam'), ('test:c3', 'Kim')`);
    const out = await bot(['contacts', 'test:c1']);
    assert.match(out, /No contacts for this job yet\.\nYou know someone at Acme Inc\. \(from other jobs\):\n {2}#\d+ Sam \(other\)/);
    assert.doesNotMatch(out, /Kim/);
    assert.match(await bot(['contacts']), /Usage: contacts <id>/);
  });

  it('mark --reason stores the skip reason and rejects unknown ones', async () => {
    assert.match(await bot(['mark', 'test:c1', 'skipped', '--reason', 'seniority']), /→ skipped/);
    assert.equal((await pool.query('SELECT reason FROM job_events')).rows[0].reason, 'seniority');
    assert.match(await bot(['mark', 'test:c1', 'new', '--reason', 'boredom']), /Usage: mark/);
  });
});
