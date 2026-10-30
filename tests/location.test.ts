import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { path } from '../src/config.ts';
import { himalayasRegion, utcHours } from '../src/sources/boards.ts';
import { scoreJob } from '../src/match.ts';

// The AI review's location check: the whole description decides whether the candidate can take a job.
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-location-'));
const run = promisify(execFile);
let claudeLog: string;

async function bot(args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: path(),
    env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: claudeLog, JOB_BOT_NOTIFY: 'off', ...env },
    timeout: 60_000,
  });
  return stdout;
}
const arg = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const claudeCalls = () =>
  existsSync(claudeLog)
    ? readFileSync(claudeLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
    : [];

const review = (eligible: string, reason: string, verdict = 'strong') =>
  JSON.stringify({ score: 88, verdict, summary: 'Fit', reasons: [], gaps: [], red_flags: ['old flag'], location: { eligible, reason } });

async function insertJob(id: string, o: Record<string, unknown> = {}) {
  const row = {
    id,
    source: 'linkedin',
    company: 'Acme',
    title: 'Senior Backend Engineer',
    location: 'Saudi Arabia',
    country: 'SA',
    url: `https://example.com/${id}`,
    description: 'Node.js, TypeScript, PostgreSQL. Fully remote: work remotely from Slovenia.',
    status: 'new',
    score: 77,
    ...o,
  };
  const cols = Object.keys(row);
  await pool.query(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return id;
}

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, job_events CASCADE');
  claudeLog = join(mkdtempSync(join(tmp, 'logs-')), 'claude.jsonl');
});
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('AI location check', () => {
  it('asks Claude to read the whole description for where the candidate may live and work', async () => {
    const id = await insertJob('loc:prompt');
    await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: review('yes', 'Saudi Arabia, visa provided') });
    const [{ argv }] = claudeCalls();
    const system = arg(argv, '--system-prompt');
    assert.match(system, /read the WHOLE description, not only the LOCATION line/);
    assert.match(system, /authorized to work in X without sponsorship/);
    assert.match(system, /work remotely from Slovenia/);
    assert.match(system, /the description wins over the\s+LOCATION line/);
    assert.match(system, /never assume sponsorship/);
    assert.match(system, /"unclear" when it says nothing about visa or relocation/);
    // From the owner's profile and config, not hardcoded.
    assert.match(system, /far from Pakistan's time zone \(GMT\+5\)/);
    assert.match(system, /that is not Pakistan and not a target country/);
    const schema = JSON.parse(arg(argv, '--json-schema'));
    assert.ok(schema.required.includes('location'));
    assert.deepEqual(schema.properties.location.properties.eligible.enum, ['yes', 'no', 'unclear']);
  });

  it('"no" moves a matching job to Filtered out with the quoted reason, logs it, and sends no strong alert', async () => {
    const id = await insertJob('loc:no');
    const out = await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: review('no', '"Work remotely from Slovenia"') });
    assert.match(out, /→ filtered: location \("Work remotely from Slovenia"\)/);
    assert.doesNotMatch(out, /Alert:/);
    const j = (await getJob(id))!;
    assert.deepEqual(
      [j.status, j.filter_reason, j.ai_location, j.ai_location_reason],
      ['filtered', 'location (AI): "Work remotely from Slovenia"', 'no', '"Work remotely from Slovenia"'],
    );
    const { rows } = await pool.query('SELECT from_status, to_status, note FROM job_events WHERE job_id = $1', [id]);
    assert.deepEqual(rows, [{ from_status: 'new', to_status: 'filtered', note: 'location (AI): "Work remotely from Slovenia"' }]);
  });

  it('a job the user already acted on keeps its status; the reason is still stored', async () => {
    const id = await insertJob('loc:applied', { status: 'applied', applied_at: new Date().toISOString() });
    await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: review('no', 'US only') });
    const j = (await getJob(id))!;
    assert.deepEqual([j.status, j.ai_location, j.filter_reason], ['applied', 'no', null]);
  });

  it('"unclear" adds a flag to confirm the location; "yes" changes nothing', async () => {
    const a = await insertJob('loc:unclear', { location: 'Remote', country: 'RM' });
    await bot(['ai:score', '--id', a], { FAKE_CLAUDE_OUT: review('unclear', 'no location stated', 'good') });
    const ja = (await getJob(a))!;
    assert.equal(ja.status, 'new');
    assert.deepEqual(ja.ai_flags, ['Location unclear: confirm you can work from where you live (no location stated)', 'old flag']);

    const b = await insertJob('loc:yes');
    await bot(['ai:score', '--id', b], { FAKE_CLAUDE_OUT: review('yes', 'visa sponsored', 'good') });
    const jb = (await getJob(b))!;
    assert.deepEqual([jb.status, jb.ai_location, jb.ai_flags], ['new', 'yes', ['old flag']]);
  });

  it('a review without a location answer (older replies) is stored as unknown and changes nothing', async () => {
    const id = await insertJob('loc:none');
    await bot(['ai:score', '--id', id], {
      FAKE_CLAUDE_OUT: JSON.stringify({ score: 70, verdict: 'good', summary: 's', reasons: [], gaps: [], red_flags: [] }),
    });
    const j = (await getJob(id))!;
    assert.deepEqual([j.status, j.ai_location, j.ai_location_reason], ['new', null, null]);
  });

  it('stays filtered when re-scored, even though the keyword rules would match it again', async () => {
    const id = await insertJob('loc:rescore', {
      source: 'greenhouse',
      description: 'Node.js, TypeScript, PostgreSQL, React. Visa sponsorship provided.',
    });
    await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: review('no', 'must reside in Slovenia') });
    await bot(['rescore']);
    const j = (await getJob(id))!;
    assert.deepEqual([j.status, j.filter_reason], ['filtered', 'location (AI): must reside in Slovenia']);
  });
});

describe('Himalayas time zones', () => {
  it('a job limited to time zones far from Pakistan is not "Worldwide"', () => {
    assert.equal(himalayasRegion([], [-10, -9, -8, -7, -6, -5, 14], 5), 'time zones UTC-10, UTC-9, UTC-8, UTC-7, UTC-6, UTC-5, UTC+14');
    assert.equal(himalayasRegion(['United States'], [-8, -5], 5), 'United States (time zones UTC-8, UTC-5)');
    assert.equal(himalayasRegion(null, [3, 4, 5], 5), 'Worldwide'); // includes Pakistan's GMT+5
    assert.equal(himalayasRegion(['Pakistan', 'India'], [5, 6], 5), 'Pakistan, India');
    assert.equal(himalayasRegion(undefined, undefined, 5), 'Worldwide');
    assert.equal(himalayasRegion([], [-8, -5], null), 'Worldwide'); // no utcOffset in the profile: time zones are not checked
    assert.equal(himalayasRegion([], [5.5], 5.5), 'Worldwide');
  });

  it("reads the profile's UTC offset", () => {
    assert.deepEqual(['GMT+5', 'UTC-3', 'GMT+5:30', 'GMT −4', '', null].map(utcHours), [5, -3, 5.5, -4, null, null]);
  });

  it('the remote filter drops such a job', () => {
    const s = scoreJob({
      id: 'himalayas:x',
      source: 'himalayas',
      company: 'Velocity',
      title: 'Frontend Engineer',
      location: `Remote — ${himalayasRegion([], [-8, -5], 5)}`,
      url: 'https://himalayas.app/x',
      description: 'React, Next.js, TypeScript',
      posted_at: null,
    });
    assert.equal(s.country, null);
    assert.match(s.filterReason ?? '', /region does not include Pakistan: time zones UTC/);
  });
});
