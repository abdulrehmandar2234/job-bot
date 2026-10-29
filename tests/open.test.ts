import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { mockFetch, TEST_DB } from './helpers.ts';
import { timing } from '../src/sources/http.ts';
import { closedText, genericRedirect, isOpen, resetOpenChecks, workdayApiUrl, type OpenJob } from '../src/sources/open.ts';
import { checkAll, checkOpen, record, selectJobs, type CheckJob } from '../src/commands/open.ts';
import { duplicateLinks, getJob, migrate, pool, type DedupeRow } from '../src/db.ts';
import { path } from '../src/config.ts';

const cacheDir = mkdtempSync(join(tmpdir(), 'job-bot-open-'));
before(async () => {
  timing.scale = 0;
  process.env.JOB_BOT_HTTP_CACHE = cacheDir;
  await migrate();
});
beforeEach(resetOpenChecks);
let net: ReturnType<typeof mockFetch> | undefined;
afterEach(() => {
  net?.restore();
  net = undefined;
});
after(async () => {
  await pool.end();
  rmSync(cacheDir, { recursive: true, force: true });
});

const job = (id: string, url = 'https://example.com/jobs/123', source = id.split(':')[0]): OpenJob => ({ id, source, url });
const status = (n: number, body = '') => () => new Response(body, { status: n });
const redirectedTo = (url: string, body = '<html>Careers</html>') => () => {
  const res = new Response(body);
  Object.defineProperty(res, 'url', { value: url });
  return res;
};

describe('isOpen: company ATS APIs', () => {
  it('greenhouse asks the posting endpoint: 200 = open, 404 = closed', async () => {
    net = mockFetch({ 'boards/acme/jobs/7': { id: 7 } });
    assert.equal((await isOpen(job('greenhouse:acme:7'))).state, 'open');
    assert.deepEqual(net.calls, ['https://boards-api.greenhouse.io/v1/boards/acme/jobs/7']);
    net.restore();
    net = mockFetch({ 'boards/acme/jobs/7': status(404) });
    assert.deepEqual(await isOpen(job('greenhouse:acme:7')), { state: 'closed', reason: 'greenhouse 404' });
  });

  it('lever, recruitee and smartrecruiters use their posting endpoints', async () => {
    net = mockFetch({ 'api.lever.co/v0/postings/acme/abc': status(404), 'acme.recruitee.com/api/offers/3': { offer: {} },
      'api.smartrecruiters.com/v1/companies/acme/postings/99': status(410) });
    assert.equal((await isOpen(job('lever:acme:abc'))).state, 'closed');
    assert.equal((await isOpen(job('recruitee:acme:3'))).state, 'open');
    assert.equal((await isOpen(job('smartrecruiters:acme:99'))).state, 'closed');
  });

  it('ashby: checks the board list, loaded once for all jobs of a company', async () => {
    net = mockFetch({ 'api.ashbyhq.com/posting-api/job-board/acme': { jobs: [{ id: 'q1' }] } });
    assert.equal((await isOpen(job('ashby:acme:q1'))).state, 'open');
    assert.deepEqual(await isOpen(job('ashby:acme:gone')), { state: 'closed', reason: 'no longer on the Ashby board' });
    assert.equal(net.calls.length, 1);
  });

  it('workable: checks the widget list; a 403 (Cloudflare) is unknown', async () => {
    net = mockFetch({ 'apply.workable.com/api/v1/widget/accounts/acme': { jobs: [{ shortcode: 'W1' }] } });
    assert.equal((await isOpen(job('workable:acme:W1'))).state, 'open');
    assert.equal((await isOpen(job('workable:acme:W2'))).state, 'closed');
    net.restore();
    resetOpenChecks();
    net = mockFetch({ 'apply.workable.com': status(403) });
    assert.equal((await isOpen(job('workable:acme:W1'))).state, 'unknown');
  });

  it('workday: maps the job URL to the CXS posting endpoint', async () => {
    const url = 'https://acme.wd3.myworkdayjobs.com/en-US/External/job/Dubai/Engineer_R123';
    assert.equal(workdayApiUrl(url), 'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/Dubai/Engineer_R123');
    assert.equal(workdayApiUrl('https://acme.wd3.myworkdayjobs.com/External/job/X_R1'),
      'https://acme.wd3.myworkdayjobs.com/wday/cxs/acme/External/job/X_R1');
    net = mockFetch({ '/wday/cxs/acme/External/job/Dubai/Engineer_R123': status(404) });
    assert.equal((await isOpen(job('workday:acme:R123', url))).state, 'closed');
  });
});

describe('isOpen: job pages (remote boards, Bayt, manual)', () => {
  const page = (id = 'remotive:1') => job(id, 'https://remotive.com/remote-jobs/software-dev/engineer-123');

  it('a 200 page without a closed notice is open', async () => {
    net = mockFetch({ 'remotive.com': '<html><h1>Engineer</h1><button>Apply</button></html>' });
    assert.equal((await isOpen(page())).state, 'open');
  });

  it('404 and 410 are closed', async () => {
    net = mockFetch({ 'remotive.com': status(404) });
    assert.deepEqual(await isOpen(page()), { state: 'closed', reason: 'remotive 404' });
    net.restore();
    net = mockFetch({ 'remotive.com': status(410) });
    assert.equal((await isOpen(page())).state, 'closed');
  });

  it('a page that says the job is closed is closed', async () => {
    for (const text of ['No longer accepting applications', 'This job has expired', 'The position has been filled',
      'This job is no longer available']) {
      net = mockFetch({ 'remotive.com': `<html><div class="notice">${text}</div></html>` });
      const r = await isOpen(page());
      assert.equal(r.state, 'closed', text);
      assert.match(r.reason, /page says/);
      net.restore();
    }
  });

  it('ignores closed wording inside scripts', () => {
    assert.equal(closedText('<script>const msg = "This job has expired";</script><p>Apply today</p>'), null);
  });

  it('a redirect to a generic careers page is closed; one that keeps the job id is not', async () => {
    net = mockFetch({ 'remotive.com': redirectedTo('https://remotive.com/remote-jobs') });
    assert.match((await isOpen(page())).reason, /redirected to https:\/\/remotive\.com\/remote-jobs/);
    assert.equal(genericRedirect('https://boards.greenhouse.io/acme/jobs/7', 'https://boards.greenhouse.io/acme?error=true'), true);
    assert.equal(genericRedirect('https://x.com/jobs/engineer-123', 'https://x.com/'), true);
    assert.equal(genericRedirect('https://x.com/jobs/engineer-123', 'https://apply.x.com/engineer-123/apply'), false);
    assert.equal(genericRedirect('https://x.com/jobs/engineer-123', 'https://x.com/jobs/engineer-123/'), false);
  });

  it('5xx and network errors are unknown, never closed', async () => {
    net = mockFetch({ 'remotive.com': status(503) });
    assert.equal((await isOpen(page())).state, 'unknown');
    net.restore();
    net = mockFetch({ 'remotive.com': () => { throw new TypeError('fetch failed'); } });
    const r = await isOpen(page());
    assert.equal(r.state, 'unknown');
    assert.match(r.reason, /gave up/);
  });
});

describe('isOpen: LinkedIn', () => {
  const li = (n: number) => job(`linkedin:${n}`, `https://www.linkedin.com/jobs/view/${n}/`);

  it('reads the guest posting endpoint', async () => {
    net = mockFetch({
      'jobPosting/1': '<figcaption class="closed-job__flavor--closed">No longer accepting applications</figcaption>',
      'jobPosting/2': '<section class="description">Build things</section>',
    });
    assert.equal((await isOpen(li(1))).state, 'closed');
    assert.equal((await isOpen(li(2))).state, 'open');
    assert.ok(net.calls.every((u) => u.startsWith('https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/')));
  });

  it('a 429 stops LinkedIn checks for the run, without retries; other sources go on', async () => {
    net = mockFetch({ linkedin: status(429), 'remotive.com': 'ok' });
    assert.equal((await isOpen(li(1))).state, 'unknown');
    assert.equal(net.calls.length, 1);
    const second = await isOpen(li(2));
    assert.deepEqual([second.state, net.calls.length], ['unknown', 1]);
    assert.match(second.reason, /rate limit/);
    assert.equal((await isOpen(job('remotive:1', 'https://remotive.com/x-1'))).state, 'open');
  });
});

describe('checkAll pacing', () => {
  it('runs at most 2 checks at a time and waits between requests to the same host', async () => {
    const jobs = [job('remotive:1', 'https://a.com/1'), job('remotive:2', 'https://a.com/2'), job('remotive:3', 'https://b.com/3'),
      job('greenhouse:acme:4'), job('greenhouse:acme:5')];
    const waits: number[] = [];
    let running = 0;
    let peak = 0;
    const out = await checkAll(jobs, async (j) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return j.id;
    }, { delayMs: 1500, wait: async (ms: number) => { waits.push(ms); } });
    assert.deepEqual(out, jobs.map((j) => j.id));
    assert.equal(peak, 2);
    // a.com twice and the Greenhouse API twice: one wait each, of about the delay; b.com never waits.
    assert.equal(waits.length, 2);
    assert.ok(waits.every((ms) => ms > 1000 && ms <= 1500), String(waits));
  });
});

describe('dedupe with expired copies', () => {
  const row = (o: Partial<DedupeRow>): DedupeRow => ({
    id: 'x', company: 'Acme', title: 'Senior Backend Engineer', country: 'AE', source: 'greenhouse', status: 'new',
    first_seen_at: new Date('2026-10-01'), ...o,
  });

  it('an open copy becomes primary over an expired one, even from a less direct source', () => {
    const links = duplicateLinks([row({ id: 'gh', status: 'expired' }), row({ id: 'li', source: 'linkedin' })]);
    assert.deepEqual(links, [['gh', 'li']]);
  });

  it('a copy the user acted on still wins; expired copies alone keep the source order', () => {
    assert.deepEqual(duplicateLinks([row({ id: 'gh', status: 'expired' }), row({ id: 'li', source: 'linkedin', status: 'applied' })]),
      [['gh', 'li']]);
    assert.deepEqual(duplicateLinks([row({ id: 'li', source: 'linkedin', status: 'expired' }), row({ id: 'gh', status: 'expired' })]),
      [['li', 'gh']]);
  });
});

// ---- Database: selection, status changes and the commands ----

const insert = async (id: string, o: Record<string, unknown> = {}) => {
  const data: Record<string, unknown> = { id, source: id.split(':')[0], company: 'Acme', title: `Engineer ${id}`, country: 'AE',
    url: `https://remotive.com/remote-jobs/${id.replace(/\W/g, '-')}`, status: 'new', score: 50, ...o };
  const cols = Object.keys(data);
  await pool.query(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => data[c]));
  return id;
};
const asCheck = async (id: string) => (await getJob(id)) as unknown as CheckJob;
const events = async (id: string) => (await pool.query('SELECT from_status, to_status, note FROM job_events WHERE job_id = $1 ORDER BY id', [id])).rows;

describe('migration 006', () => {
  it('adds checked_open_at and closed_at', async () => {
    const { rows } = await pool.query(`SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'jobs' AND column_name IN ('checked_open_at', 'closed_at') ORDER BY 1`);
    assert.deepEqual(rows, [{ column_name: 'checked_open_at', data_type: 'timestamp with time zone' },
      { column_name: 'closed_at', data_type: 'timestamp with time zone' }]);
    const { rows: done } = await pool.query(`SELECT 1 FROM schema_migrations WHERE version = '006_expired'`);
    assert.equal(done.length, 1);
  });
});

describe('check:open selection and status changes', () => {
  beforeEach(() => pool.query('TRUNCATE jobs, job_events CASCADE'));

  it('by default picks new + prepared primaries not checked in 3 days, never-checked first, up to --limit', async () => {
    await insert('remotive:fresh', { checked_open_at: new Date() });
    await insert('remotive:old', { checked_open_at: new Date(Date.now() - 4 * 86_400_000), score: 90 });
    await insert('remotive:never', { score: 10 });
    await insert('remotive:prep', { status: 'prepared', score: 60 });
    await insert('remotive:applied', { status: 'applied' });
    await insert('remotive:copy', { duplicate_of: 'remotive:never' });
    assert.deepEqual((await selectJobs([], ['new', 'prepared'])).map((j) => j.id), ['remotive:prep', 'remotive:never', 'remotive:old']);
    assert.deepEqual((await selectJobs([], ['new', 'prepared'], 1)).map((j) => j.id), ['remotive:prep']);
    assert.deepEqual((await selectJobs([], ['applied'])).map((j) => j.id), ['remotive:applied']);
    assert.deepEqual((await selectJobs(['remotive:applied', 'remotive:fresh', 'nope'], [])).map((j) => j.id),
      ['remotive:applied', 'remotive:fresh']);
  });

  it('a closed posting moves a new job to expired with a history note', async () => {
    const id = await insert('remotive:1');
    assert.equal(await record(await asCheck(id), { state: 'closed', reason: 'remotive 404' }), 'expired');
    const j = await getJob(id);
    assert.equal(j.status, 'expired');
    assert.ok(j.closed_at && j.checked_open_at);
    assert.deepEqual(await events(id), [{ from_status: 'new', to_status: 'expired', note: 'posting closed (remotive 404)' }]);
  });

  it('never expires a job you applied to or are interviewing for: only reports it', async () => {
    for (const s of ['applied', 'interview']) {
      const id = await insert(`remotive:${s}`, { status: s });
      assert.equal(await record(await asCheck(id), { state: 'closed', reason: 'remotive 404' }), 'reported');
      const j = await getJob(id);
      assert.equal(j.status, s);
      assert.ok(j.closed_at);
      assert.deepEqual(await events(id), []);
    }
  });

  it('an unknown result changes nothing, so the job is checked again next run', async () => {
    const id = await insert('remotive:1');
    assert.equal(await record(await asCheck(id), { state: 'unknown', reason: 'remotive: 503' }), 'unknown');
    const j = await getJob(id);
    assert.deepEqual([j.status, j.checked_open_at, j.closed_at], ['new', null, null]);
  });

  it('a job the check expired goes back to its old status when the posting is open again', async () => {
    const id = await insert('remotive:1', { status: 'prepared' });
    await record(await asCheck(id), { state: 'closed', reason: 'redirected to https://remotive.com/' });
    assert.equal(await record(await asCheck(id), { state: 'open', reason: 'job page 200' }), 'reopened');
    const j = await getJob(id);
    assert.deepEqual([j.status, j.closed_at], ['prepared', null]);
    // One you marked expired yourself stays expired.
    const mine = await insert('remotive:2', { status: 'expired' });
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status, note) VALUES ($1, 'new', 'expired', 'saw it closed')`, [mine]);
    assert.equal(await record(await asCheck(mine), { state: 'open', reason: 'job page 200' }), 'open');
    assert.equal((await getJob(mine)).status, 'expired');
  });

  it('checkOpen checks, expires, reports and prints a summary', async () => {
    await insert('greenhouse:acme:1');
    await insert('greenhouse:acme:2', { status: 'prepared' });
    await insert('greenhouse:acme:3', { status: 'applied' });
    await insert('remotive:4');
    net = mockFetch({ 'jobs/1': { id: 1 }, 'jobs/2': status(404), 'jobs/3': status(404), 'remotive.com': status(502) });
    const log = mock.method(console, 'log', () => {});
    try {
      await checkOpen([], {});
      await checkOpen(['greenhouse:acme:3'], {});
    } finally {
      log.mock.restore();
    }
    const out = log.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.match(out, /Checking 3 postings/); // the applied job is not in the default selection
    assert.match(out, /✗ expired\s+Acme — Engineer greenhouse:acme:2 \(greenhouse 404\)/);
    assert.match(out, /\? unknown\s+Acme — Engineer remotive:4/);
    assert.match(out, /3 checked: 1 open, 1 closed → expired, 0 closed but status kept, 1 unknown/);
    assert.match(out, /status applied kept, you are already in the process/);
    assert.equal((await getJob('greenhouse:acme:1')).status, 'new');
    assert.equal((await getJob('greenhouse:acme:2')).status, 'expired');
    assert.equal((await getJob('greenhouse:acme:3')).status, 'applied');
    assert.equal((await getJob('remotive:4')).checked_open_at, null);
  });

  it('checkOpen rejects bad flags', async () => {
    const log = mock.method(console, 'log', () => {});
    try {
      await checkOpen([], { status: 'new,bogus' });
      await checkOpen([], { limit: '0' });
    } finally {
      log.mock.restore();
      process.exitCode = 0;
    }
    assert.equal(log.mock.calls.filter((c) => /Usage: check:open/.test(String(c.arguments[0]))).length, 2);
  });
});

// ---- The real CLI: prepare and check:open with a fake fetch (tests/fixtures/fake-fetch.mjs) ----

const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_FETCH = pathToFileURL(join(import.meta.dirname, 'fixtures', 'fake-fetch.mjs')).href;
const run = promisify(execFile);
async function bot(args: string[], fetchRoutes: Record<string, object> = {}, env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], {
    cwd: path(), timeout: 60_000,
    env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE_CLAUDE, NODE_OPTIONS: `--import=${FAKE_FETCH}`,
      FAKE_FETCH: JSON.stringify(fetchRoutes), JOB_BOT_HTTP_CACHE: cacheDir, ...env },
  });
  return stdout;
}

describe('CLI', () => {
  beforeEach(() => pool.query('TRUNCATE jobs, job_events CASCADE'));

  it('prepare stops on a closed posting and marks it expired', async () => {
    const id = await insert('greenhouse:acme:9', { company: 'Testco Open' });
    const out = await bot(['prepare', id], { 'boards/acme/jobs/9': { status: 404 } });
    assert.match(out, /the posting is closed \(greenhouse 404\)/);
    assert.match(out, /Marked expired\. Nothing prepared\./);
    assert.match(out, /prepare greenhouse:acme:9 --force/);
    const j = await getJob(id);
    assert.deepEqual([j.status, j.cv_version, j.cover_letter], ['expired', null, null]);
  });

  it('prepare --force skips the check and prepares an expired job', async () => {
    const id = await insert('greenhouse:acme:9', { company: 'Testco Open', status: 'expired' });
    const log = join(cacheDir, 'fetch.log');
    const out = await bot(['prepare', id, '--force', '--template'], { 'boards/acme/jobs/9': { status: 404 } }, { FAKE_FETCH_LOG: log });
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(log), false); // no request at all
    const j = await getJob(id);
    assert.deepEqual([j.status, j.cv_version], ['prepared', 'default']);
  });

  it('check:open marks closed postings expired and leaves applied ones alone', async () => {
    await insert('greenhouse:acme:1');
    await insert('greenhouse:acme:2', { status: 'applied' });
    const out = await bot(['check:open', 'greenhouse:acme:1', 'greenhouse:acme:2'], { 'boards/acme/jobs/': { status: 404 } });
    assert.match(out, /2 checked: 0 open, 1 closed → expired, 1 closed but status kept, 0 unknown/);
    assert.equal((await getJob('greenhouse:acme:1')).status, 'expired');
    assert.equal((await getJob('greenhouse:acme:2')).status, 'applied');
    assert.match(await bot(['mark', 'greenhouse:acme:2', 'expired']), /→ expired/);
  });
});

// ---- scripts/daily-fetch.sh: check:open runs after fetch, and its failure does not stop the notification ----

describe('scripts/daily-fetch.sh', () => {
  it('runs check:open --limit 100 after fetch; a failing check still notifies', () => {
    const root = mkdtempSync(join(tmpdir(), 'job-bot-daily-'));
    try {
      const home = join(root, 'home');
      const bin = join(home, '.local', 'bin');
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(root, 'repo', 'scripts'), { recursive: true });
      mkdirSync(join(root, 'repo', 'data'));
      copyFileSync(path('scripts', 'daily-fetch.sh'), join(root, 'repo', 'scripts', 'daily-fetch.sh'));
      const calls = join(root, 'calls.txt');
      const fake = (file: string, body: string) => { writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755); };
      fake(join(bin, 'node'), `echo "node $*" >> "${calls}"\ncase "$*" in *check:open*) exit 1;; *fetch*) echo "10 postings checked, 1 new.";; esac`);
      fake(join(bin, 'osascript'), `echo "osascript $*" >> "${calls}"`);
      fake(join(root, 'repo', 'scripts', 'backup-db.sh'), 'exit 0');
      const r = spawnSync('/bin/zsh', [join(root, 'repo', 'scripts', 'daily-fetch.sh')], { encoding: 'utf8', env: { HOME: home } });
      assert.equal(r.status, 0, r.stderr);
      const lines = readFileSync(calls, 'utf8').trim().split('\n');
      assert.match(lines[0], /src\/cli\.ts fetch$/);
      assert.match(lines[1], /src\/cli\.ts check:open --limit 100$/);
      assert.match(lines[2], /src\/cli\.ts ai:score$/);
      assert.match(lines[3], /^osascript .*10 postings checked/);
      assert.match(readFileSync(join(root, 'repo', 'data', 'fetch.log'), 'utf8'), /check:open failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
