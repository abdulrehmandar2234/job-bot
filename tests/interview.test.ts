import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { path } from '../src/config.ts';
import { notify, notifyCommand, osascriptArgs, strongAlerts, type AlertJob } from '../src/notify.ts';
import type { InterviewPrep } from '../src/types.ts';

// Interview prep (`prep`) and strong-match alerts (`ai:score`), through the real CLI with a fake Claude and a fake notifier.
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_NOTIFY = join(import.meta.dirname, 'fixtures', 'fake-notify.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-interview-'));
const run = promisify(execFile);
let claudeLog: string;
let notifyLog: string;

async function bot(args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: path(),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB,
      JOB_BOT_CLAUDE: FAKE_CLAUDE,
      FAKE_CLAUDE_LOG: claudeLog,
      JOB_BOT_NOTIFY: FAKE_NOTIFY,
      FAKE_NOTIFY_LOG: notifyLog,
      ...env,
    },
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
const notes = () =>
  existsSync(notifyLog)
    ? readFileSync(notifyLog, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as [string, string, string])
    : [];
const arg = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

/** A temp copy of config.json with `edit` applied, as env for the CLI. */
function configWith(edit: (c: { ai: Record<string, unknown> }) => void) {
  const c = JSON.parse(readFileSync(path('config.json'), 'utf8'));
  edit(c);
  const f = join(mkdtempSync(join(tmp, 'config-')), 'config.json');
  writeFileSync(f, JSON.stringify(c));
  return { JOB_BOT_CONFIG: f };
}

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
    status: 'new',
    score: 70,
    ...o,
  };
  const cols = Object.keys(row);
  await pool.query(`INSERT INTO jobs (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(row));
  return id;
}

const PREP: InterviewPrep = {
  technical: [{ question: 'How do you structure a large Laravel app?', hint: 'Abyan Capital KYC and portfolio modules.' }],
  behavioural: [{ question: 'Tell me about a hard deadline.', situation: 'S', task: 'T', action: 'A', result: 'R' }],
  company: { brief: 'Acme builds payments software (from the posting).', verify: ['Verify before interview: team size'] },
  questions_to_ask: ['How is the team split between product areas?'],
  requirements: [
    { requirement: 'Laravel', evidence: 'Years of Laravel at Abyan Capital', gap: false },
    { requirement: 'Kubernetes', evidence: 'Not in the CV', gap: true },
  ],
};
const review = (verdict: string, score = 90) => JSON.stringify({ score, verdict, summary: 'Apply', reasons: [], gaps: [], red_flags: [] });

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE');
  const d = mkdtempSync(join(tmp, 'logs-'));
  claudeLog = join(d, 'claude.jsonl');
  notifyLog = join(d, 'notify.jsonl');
});
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('prep', () => {
  it('stores the AI prep as JSON and prints a summary', async () => {
    const id = await insertJob('prep:1', { status: 'interview' });
    const out = await bot(['prep', id], { FAKE_CLAUDE_OUT: JSON.stringify(PREP) });
    assert.match(out, /1 technical and 1 behavioural questions, 1 of 2 requirements are gaps/);
    assert.match(out, /Verify before interview: team size/);
    const j = await getJob(id);
    assert.deepEqual(j!.interview_prep, PREP);
    assert.ok(Date.now() - j!.interview_prep_at!.getTime() < 60_000);
  });

  it('asks the letter model with the CV, the job and the truthfulness rules', async () => {
    const id = await insertJob('prep:2');
    await bot(['prep', id], { FAKE_CLAUDE_OUT: JSON.stringify(PREP) });
    const [{ argv, stdin }] = claudeCalls();
    assert.equal(arg(argv, '--model'), JSON.parse(readFileSync(path('config.json'), 'utf8')).ai.letterModel);
    assert.match(stdin, /CV:\nAbdul Rehman Dar[\s\S]*JOB:\nTITLE: Senior Laravel Developer\nCOMPANY: Acme/);
    const system = arg(argv, '--system-prompt');
    assert.match(system, /Use ONLY facts in the CV/);
    assert.match(system, /Never claim a skill\s+or experience the CV does not show/);
    assert.match(system, /NO web access/);
    assert.match(system, /ONLY from the job description and the company name/);
    assert.match(system, /Verify before\s+interview/);
    const schema = JSON.parse(arg(argv, '--json-schema'));
    assert.deepEqual(schema.required, ['technical', 'behavioural', 'company', 'questions_to_ask', 'requirements']);
    assert.deepEqual(schema.properties.behavioural.items.required, ['question', 'situation', 'task', 'action', 'result']);
  });

  it('keeps the old prep and fails when Claude fails', async () => {
    const id = await insertJob('prep:3', { interview_prep: JSON.stringify(PREP) });
    await assert.rejects(bot(['prep', id], { FAKE_CLAUDE_FAIL: 'usage limit reached' }), /usage limit reached/);
    assert.deepEqual((await getJob(id))!.interview_prep, PREP);
  });

  it('reports unknown jobs and AI being off without calling Claude', async () => {
    assert.match(await bot(['prep', 'nope']), /Not found/);
    const id = await insertJob('prep:4');
    assert.match(
      await bot(
        ['prep', id],
        configWith((c) => {
          c.ai.enabled = false;
        }),
      ),
      /AI is off/,
    );
    assert.deepEqual(claudeCalls(), []);
  });

  it('mark interview suggests prep but never runs AI', async () => {
    const id = await insertJob('prep:5', { status: 'applied' });
    assert.match(await bot(['mark', id, 'interview']), new RegExp(`Prepare for it: npm run bot -- prep ${id}`));
    assert.doesNotMatch(await bot(['mark', id, 'offer']), /Prepare for it/);
    assert.deepEqual(claudeCalls(), []);
    assert.equal((await getJob(id))!.interview_prep, null);
  });
});

describe('strong-match alerts (ai:score)', () => {
  it('sends one notification per strong job with a link to it, and records alerted_at', async () => {
    const id = await insertJob('greenhouse:acme:1', { title: 'Senior "PHP" Dev', company: "O'Neil & Co" });
    const out = await bot(['ai:score'], { FAKE_CLAUDE_OUT: review('strong') });
    assert.match(out, /Alert: Strong match: Senior "PHP" Dev at O'Neil & Co \(UAE\)/);
    assert.deepEqual(notes(), [
      ['Job Bot', 'Strong match: Senior "PHP" Dev at O\'Neil & Co (UAE)', 'http://localhost:3100/jobs/greenhouse%3Aacme%3A1'],
    ]);
    assert.ok((await getJob(id))!.alerted_at);
  });

  it('does not alert for other verdicts', async () => {
    const id = await insertJob('a:good');
    await bot(['ai:score'], { FAKE_CLAUDE_OUT: review('good', 75) });
    assert.deepEqual(notes(), []);
    assert.equal((await getJob(id))!.alerted_at, null);
  });

  it('alerts a job only once, even when it is re-scored', async () => {
    const id = await insertJob('a:once');
    await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: review('strong') });
    const first = (await getJob(id))!.alerted_at;
    const out = await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: review('strong') });
    assert.doesNotMatch(out, /Alert:/);
    assert.equal(notes().length, 1);
    assert.deepEqual((await getJob(id))!.alerted_at, first);
  });

  it('groups more than three strong jobs into one notification', async () => {
    for (const n of [1, 2, 3, 4]) await insertJob(`a:g${n}`, { title: `Dev ${n}`, company: `Co${n}`, score: 90 - n });
    await bot(['ai:score'], { FAKE_CLAUDE_OUT: review('strong') });
    const all = notes();
    assert.equal(all.length, 1);
    assert.match(all[0][1], /^4 strong matches: (Dev \d at Co\d, ){2}Dev \d at Co\d…$/);
    assert.equal(all[0][2], 'http://localhost:3100');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM jobs WHERE alerted_at IS NOT NULL');
    assert.equal(rows[0].n, 4);
  });

  it('ai.alertStrong false turns alerts off; a missing setting means on', async () => {
    const off = await insertJob('a:off');
    await bot(['ai:score'], {
      ...configWith((c) => {
        c.ai.alertStrong = false;
      }),
      FAKE_CLAUDE_OUT: review('strong'),
    });
    assert.deepEqual(notes(), []);
    assert.equal((await getJob(off))!.alerted_at, null);

    await insertJob('a:default');
    await bot(['ai:score'], {
      ...configWith((c) => {
        delete c.ai.alertStrong;
      }),
      FAKE_CLAUDE_OUT: review('strong'),
    });
    assert.equal(notes().length, 1);
  });

  it('JOB_BOT_NOTIFY=off sends nothing but still records the alert', async () => {
    const id = await insertJob('a:silent');
    assert.match(await bot(['ai:score'], { JOB_BOT_NOTIFY: 'off', FAKE_CLAUDE_OUT: review('strong') }), /Alert: Strong match/);
    assert.deepEqual(notes(), []);
    assert.ok((await getJob(id))!.alerted_at);
  });

  it('the daily fetch script runs ai:score, so it alerts with no extra step', () => {
    assert.match(readFileSync(path('scripts', 'daily-fetch.sh'), 'utf8'), /src\/cli\.ts ai:score/);
  });
});

describe('ai:score failures', () => {
  /** Runs the CLI and returns its exit code and output, failing or not. */
  async function botResult(args: string[], env: Record<string, string> = {}) {
    try {
      return { code: 0, stdout: await bot(args, env), stderr: '' };
    } catch (e) {
      const err = e as { code: number; stdout: string; stderr: string };
      return { code: err.code, stdout: err.stdout, stderr: err.stderr };
    }
  }

  it('--id exits 1 with the error when that job fails', async () => {
    const id = await insertJob('f:one');
    const r = await botResult(['ai:score', '--id', id], { FAKE_CLAUDE_FAIL: 'Not logged in' });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /0 jobs scored, 1 failed\./);
    assert.match(r.stderr, /AI review failed for 1 of 1 job: .*Not logged in/);
    assert.equal((await getJob(id))!.ai_scored_at, null);
  });

  it('exits 1 when every job in the queue fails', async () => {
    await insertJob('f:a');
    await insertJob('f:b');
    const r = await botResult(['ai:score'], { FAKE_CLAUDE_FAIL: 'Not logged in' });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /AI review failed for 2 of 2 jobs/);
  });

  it('exits 0 when some jobs of the queue are scored', async () => {
    await insertJob('f:ok');
    await insertJob('f:bad', { description: 'FAIL_ME' });
    // A fake Claude that fails only for the job whose description says so.
    const dir = mkdtempSync(join(tmp, 'claude-'));
    const fake = join(dir, 'claude.mjs');
    writeFileSync(
      fake,
      `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const stdin = readFileSync(0, 'utf8');
if (stdin.includes('FAIL_ME')) { process.stdout.write(JSON.stringify({ is_error: true, result: 'boom' })); process.exit(1); }
process.stdout.write(JSON.stringify({ is_error: false, structured_output: ${review('good', 70)} }));`,
    );
    chmodSync(fake, 0o755);
    const r = await botResult(['ai:score'], { JOB_BOT_CLAUDE: fake });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 jobs scored, 1 failed\./);
  });

  it('the daily fetch script reports a failed AI review instead of a score count', () => {
    assert.match(readFileSync(path('scripts', 'daily-fetch.sh'), 'utf8'), /AI review failed/);
  });
});

describe('notify', () => {
  const job = (n: number, o: Partial<AlertJob> = {}): AlertJob => ({
    id: `x:${n}`,
    title: `Dev ${n}`,
    company: `Co${n}`,
    country: 'NL',
    ...o,
  });
  const name = (c: string | null) => c ?? '?';

  it('strongAlerts sends up to three single notes and groups above that', () => {
    assert.equal(strongAlerts([job(1), job(2), job(3)], name).length, 3);
    assert.deepEqual(strongAlerts([job(1), job(2), job(3), job(4), job(5)], name), [
      { title: 'Job Bot', message: '5 strong matches: Dev 1 at Co1, Dev 2 at Co2, Dev 3 at Co3…', url: 'http://localhost:3100' },
    ]);
    assert.deepEqual(strongAlerts([], name), []);
  });

  it('strongAlerts keeps each message on one short line', () => {
    const [n] = strongAlerts([job(1, { title: 'Dev\nline\ttwo\u0007', company: 'x'.repeat(400) })], name);
    assert.match(n.message, /^Strong match: Dev line two at x+…$/);
    assert.equal(n.message.length, 240);
  });

  it('osascript gets the texts as arguments, never inside the script source', () => {
    const evil = 'Say "hi" \\" & do shell script "touch /tmp/pwned" & "';
    const args = osascriptArgs({ title: 'Job Bot', message: evil, url: 'u' });
    assert.deepEqual(args.slice(-2), ['Job Bot', evil]);
    assert.ok(args.slice(0, -2).every((a) => !a.includes(evil)));
  });

  it('quotes and backslashes reach AppleScript unchanged', { skip: process.platform !== 'darwin' }, async () => {
    const evil = 'Say "hi" \\" & do shell script "touch /tmp/pwned" & "';
    // Same argument layout as the real call, with `return` in place of `display notification`.
    const args = osascriptArgs({ title: 'Job "Bot"', message: evil, url: 'u' }).map((a) =>
      a.startsWith('display notification') ? 'return (item 1 of argv) & "|" & (item 2 of argv)' : a,
    );
    const { stdout } = await run('osascript', args);
    assert.equal(stdout.trim(), `Job "Bot"|${evil}`);
  });

  it('notifyCommand: off, a fake program, terminal-notifier when installed, else osascript', () => {
    const n = { title: 'T', message: 'M', url: 'http://localhost:3100/jobs/1' };
    assert.equal(notifyCommand(n, { JOB_BOT_NOTIFY: 'off' }), null);
    assert.deepEqual(notifyCommand(n, { JOB_BOT_NOTIFY: '/x/fake' }), ['/x/fake', ['T', 'M', n.url]]);
    assert.deepEqual(
      notifyCommand(n, {}, (p) => p === '/opt/homebrew/bin/terminal-notifier'),
      ['/opt/homebrew/bin/terminal-notifier', ['-title', 'T', '-message', 'M', '-open', n.url]],
    );
    assert.deepEqual(
      notifyCommand(n, {}, () => false),
      ['osascript', osascriptArgs(n)],
    );
  });

  it('notify logs a failing notifier instead of throwing', async () => {
    await notify({ title: 'T', message: 'M', url: 'u' }, { JOB_BOT_NOTIFY: '/nonexistent/notifier' });
  });
});
