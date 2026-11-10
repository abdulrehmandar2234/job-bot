import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { daysAgo, TEST_DB } from './helpers.ts';
import { dueFollowUps, getJob, markFollowedUp, migrate, pool } from '../src/db.ts';
import { path } from '../src/config.ts';
import { addressee, daysWaiting, FOLLOW_UP_DAYS, isDue, MAX_FOLLOW_UPS, templateFollowUp } from '../src/followup.ts';

// Follow-up reminders: which applied jobs are due, drafting the message (fake Claude) and recording a sent one.
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-followup-'));
const run = promisify(execFile);
let claudeLog: string;

async function bot(args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: path(),
    env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE_CLAUDE, FAKE_CLAUDE_LOG: claudeLog, ...env },
    timeout: 60_000,
  });
  return stdout;
}

const claudeCalls = () =>
  existsSync(claudeLog)
    ? readFileSync(claudeLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; stdin: string })
    : [];
const arg = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

async function insertJob(id: string, o: Record<string, unknown> = {}) {
  const row = {
    id,
    source: 'greenhouse',
    company: 'Acme',
    title: 'Senior Laravel Developer',
    location: 'Dubai',
    country: 'AE',
    url: `https://example.com/${id}`,
    description: 'Laravel, PHP, Vue.js and MySQL.',
    status: 'applied',
    score: 70,
    applied_at: daysAgo(10),
    ...o,
  };
  const cols = Object.keys(row);
  await pool.query(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return id;
}

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, job_events, contacts CASCADE');
  claudeLog = join(mkdtempSync(join(tmp, 'logs-')), 'claude.jsonl');
});
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('which jobs are due', () => {
  it(`applied ${FOLLOW_UP_DAYS}+ days ago, or that long since the last follow-up, below ${MAX_FOLLOW_UPS} sent`, async () => {
    await insertJob('fu:old', { applied_at: daysAgo(12) });
    await insertJob('fu:due', { applied_at: daysAgo(FOLLOW_UP_DAYS) });
    await insertJob('fu:recent', { applied_at: daysAgo(3) });
    await insertJob('fu:followed-recently', { applied_at: daysAgo(20), follow_ups: 1, followed_up_at: daysAgo(2) });
    await insertJob('fu:followed-long-ago', { applied_at: daysAgo(30), follow_ups: 1, followed_up_at: daysAgo(9) });
    await insertJob('fu:max', { applied_at: daysAgo(40), follow_ups: MAX_FOLLOW_UPS, followed_up_at: daysAgo(20) });
    await insertJob('fu:interview', { status: 'interview', applied_at: daysAgo(20) });
    await insertJob('fu:rejected', { status: 'rejected', applied_at: daysAgo(20) });
    await insertJob('fu:no-date', { applied_at: null });
    await insertJob('fu:dup', { applied_at: daysAgo(20) });
    await pool.query(`UPDATE jobs SET duplicate_of = 'fu:old' WHERE id = 'fu:dup'`);
    // The longest wait first.
    assert.deepEqual(
      (await dueFollowUps()).map((j) => j.id),
      ['fu:old', 'fu:followed-long-ago', 'fu:due'],
    );
  });

  it('daysWaiting counts from the last follow-up, else from applying', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    assert.equal(daysWaiting({ applied_at: new Date('2026-10-19T13:00:00Z'), followed_up_at: null }, now), 9);
    assert.equal(daysWaiting({ applied_at: new Date('2026-10-01'), followed_up_at: new Date('2026-10-27T12:00:00Z') }, now), 2);
    assert.equal(daysWaiting({ applied_at: null, followed_up_at: null }, now), null);
  });

  it('isDue: applied, waiting long enough since applying or the last follow-up, below the maximum', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const at = (iso: string) => new Date(iso);
    const job = { status: 'applied' as const, applied_at: at('2026-10-20T12:00:00Z'), follow_ups: 0, followed_up_at: null };
    assert.equal(isDue(job, now), true);
    assert.equal(isDue({ ...job, applied_at: at('2026-10-23T12:00:00Z') }, now), false); // 6 days
    assert.equal(isDue({ ...job, applied_at: at('2026-10-22T12:00:00Z') }, now), true); // exactly FOLLOW_UP_DAYS
    assert.equal(isDue({ ...job, follow_ups: 1, followed_up_at: at('2026-10-27T12:00:00Z') }, now), false);
    assert.equal(isDue({ ...job, follow_ups: MAX_FOLLOW_UPS, followed_up_at: at('2026-10-01T12:00:00Z') }, now), false);
    assert.equal(isDue({ ...job, status: 'interview' }, now), false);
    assert.equal(isDue({ ...job, applied_at: null }, now), false);
    assert.equal(isDue({ status: 'applied', applied_at: job.applied_at }, now), true); // list rows without the counters
  });
});

describe('drafting', () => {
  it('addresses a recruiter first, then a hiring manager, never a referral', () => {
    assert.equal(
      addressee([
        { name: 'Ref', role: 'referral' },
        { name: 'Hana', role: 'hiring manager' },
        { name: 'Rita', role: 'recruiter' },
      ]),
      'Rita',
    );
    assert.equal(
      addressee([
        { name: 'Ref', role: 'referral' },
        { name: 'Hana', role: 'hiring manager' },
      ]),
      'Hana',
    );
    assert.equal(addressee([{ name: 'Ref', role: 'referral' }]), null);
  });

  it('the template names the role and date, and says "once more" on a second follow-up', () => {
    const job = { company: 'Acme', title: 'Laravel Developer', applied_at: new Date('2026-10-15T12:00:00Z'), follow_ups: 0 };
    const t = templateFollowUp(job, null, 'Abdul Rehman Dar');
    assert.match(t, /^Dear Acme Hiring Team,\n/);
    assert.match(t, /applied for the Laravel Developer position on 15 October and wanted to follow up on my application/);
    assert.match(t, /Best regards,\nAbdul Rehman Dar\n$/);
    assert.match(templateFollowUp({ ...job, follow_ups: 1 }, 'Rita', null), /^Dear Rita,[\s\S]*follow up once more/);
    // Without a name the letter ends at "Best regards," (no empty signature line).
    assert.match(templateFollowUp(job, null, null), /Best regards,\n$/);
  });

  it('follow-up <id> stores the AI draft, addressed to the recruiter, with the CV and the truthfulness rules', async () => {
    const id = await insertJob('fu:ai');
    await pool.query(`INSERT INTO contacts (job_id, name, role) VALUES ($1, 'Rita Recruiter', 'recruiter')`, [id]);
    const out = await bot(['follow-up', id], { FAKE_CLAUDE_OUT: JSON.stringify({ message: '  Dear Rita Recruiter,\nStill keen.  ' }) });
    assert.match(out, /Dear Rita Recruiter,\nStill keen\.\n/);
    assert.match(out, /Send it yourself, then record it: npm run bot -- followed-up fu:ai/);
    const j = (await getJob(id))!;
    assert.equal(j.follow_up_draft, 'Dear Rita Recruiter,\nStill keen.\n');
    assert.ok(Date.now() - j.follow_up_draft_at!.getTime() < 60_000);
    assert.equal(j.follow_ups, 0, 'drafting is not sending');

    const [{ argv, stdin }] = claudeCalls();
    assert.match(stdin, /CV:\nAbdul Rehman Dar[\s\S]*APPLIED ON: \d{4}-\d{2}-\d{2}[\s\S]*JOB:\nTITLE: Senior Laravel Developer/);
    const system = arg(argv, '--system-prompt');
    assert.match(system, /Start with "Dear Rita Recruiter,"/);
    assert.match(system, /Use ONLY facts in the CV/);
    assert.match(system, /This is their first follow-up/);
  });

  it('falls back to the template when Claude fails, or with --template (no AI call)', async () => {
    const id = await insertJob('fu:fallback');
    const out = await bot(['follow-up', id], { FAKE_CLAUDE_FAIL: 'usage limit reached' });
    assert.match(out, /AI follow-up failed, using template: [\s\S]*usage limit reached/);
    assert.match((await getJob(id))!.follow_up_draft!, /^Dear Acme Hiring Team,/);

    claudeLog = join(mkdtempSync(join(tmp, 'logs-')), 'claude.jsonl');
    await bot(['follow-up', id, '--template']);
    assert.equal(claudeCalls().length, 0);
  });

  it('refuses unknown jobs and jobs that are not applied', async () => {
    await assert.rejects(bot(['follow-up', 'nope']), (e: { code: number; stderr: string }) => e.code === 1 && /Not found/.test(e.stderr));
    const id = await insertJob('fu:new', { status: 'new', applied_at: null });
    assert.match(await bot(['follow-up', id]), /fu:new is new; follow-ups are for applied jobs/);
    assert.equal((await getJob(id))!.follow_up_draft, null);
  });
});

describe('recording a sent follow-up', () => {
  it('counts it, restarts the wait and logs it in the history', async () => {
    const id = await insertJob('fu:sent');
    assert.equal(await markFollowedUp(id), 1);
    const j = (await getJob(id))!;
    assert.equal(j.follow_ups, 1);
    assert.ok(Date.now() - j.followed_up_at!.getTime() < 60_000);
    assert.equal(j.status, 'applied');
    assert.deepEqual(
      (await dueFollowUps()).map((x) => x.id),
      [],
    );
    const { rows } = await pool.query('SELECT from_status, to_status, note FROM job_events WHERE job_id = $1', [id]);
    assert.deepEqual(rows, [{ from_status: 'applied', to_status: 'applied', note: 'Follow-up 1 sent' }]);
    assert.equal(await markFollowedUp('nope'), null);
  });

  it('followed-up <id> says when the next reminder comes, and that the last one ends them', async () => {
    const id = await insertJob('fu:cli');
    assert.match(await bot(['followed-up', id]), /fu:cli: follow-up 1 recorded\. Next reminder in 7 days/);
    assert.match(await bot(['followed-up', id]), /follow-up 2 recorded\. No more reminders for this job\./);
    await assert.rejects(
      bot(['followed-up', 'nope']),
      (e: { code: number; stderr: string }) => e.code === 1 && /Not found: nope/.test(e.stderr),
    );
  });

  it('follow-ups lists the due jobs with their wait', async () => {
    assert.match(await bot(['follow-ups']), /No follow-ups due/);
    await insertJob('fu:list', { applied_at: daysAgo(9), follow_ups: 1, followed_up_at: daysAgo(8) });
    const out = await bot(['follow-ups']);
    assert.match(out, /1 applications due a follow-up:\n\s+8d {2}Acme — Senior Laravel Developer {2}\(1 sent\)\n\s+id: fu:list/);
  });
});

describe('the drafted follow-up for AI off', () => {
  it('uses the template without calling Claude', async () => {
    const c = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
    c.ai.enabled = false;
    const f = join(mkdtempSync(join(tmp, 'config-')), 'config.json');
    writeFileSync(f, JSON.stringify(c));
    const id = await insertJob('fu:off');
    assert.match(await bot(['follow-up', id], { JOB_BOT_CONFIG: f }), /^Dear Acme Hiring Team,/);
    assert.equal(claudeCalls().length, 0);
  });
});
