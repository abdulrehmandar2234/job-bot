import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { daysAgo, TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { path } from '../src/config.ts';

// Runs the real CLI (same command as `npm run bot`) against the test database with a fake Claude.
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-cli-'));
const run = promisify(execFile);

async function bot(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const p = run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: path(), env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE, ...env }, timeout: 60_000,
  });
  if (stdin !== undefined) { p.child.stdin!.end(stdin); }
  return (await p).stdout;
}

const posting = (o: object = {}) => ({
  source: 'bayt', company: 'Testco Cli', title: 'Senior Laravel Developer', location: 'Dubai, UAE',
  url: 'https://www.bayt.com/en/uae/jobs/test-1/', description: 'Laravel, PHP, Vue.js, MySQL, REST APIs and Docker.',
  posted_at: daysAgo(1), ...o,
});
const addFile = (jobs: object[]) => { const f = join(tmp, `add-${Math.random()}.json`); writeFileSync(f, JSON.stringify(jobs)); return f; };
const idOf = (out: string) => out.match(/id: (\S+)/)![1];

before(migrate);
beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('CLI', () => {
  it('uses the test database, not the real one from .env', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.ok(await getJob(id));
  });

  it('add scores matching jobs and explains filtered ones', async () => {
    const out = await bot(['add', '--file', addFile([posting(), posting({ url: 'https://www.bayt.com/2', title: 'Sales Manager' })])]);
    assert.match(out, /AE\s+new\s+Testco Cli — Senior Laravel Developer/);
    assert.match(out, /filtered: title is not an engineering role/);
  });

  it('add reads JSON from stdin and gives the same id for the same url', async () => {
    const a = idOf(await bot(['add'], {}, JSON.stringify(posting())));
    const b = idOf(await bot(['add'], {}, JSON.stringify(posting({ title: 'Senior Laravel Developer (PHP)' }))));
    assert.equal(a, b);
    assert.match(a, /^bayt:[0-9a-f]{12}$/);
  });

  it('list, show and stats', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.match(await bot(['list']), /Testco Cli — Senior Laravel Developer/);
    assert.match(await bot(['list', '--country', 'sa']), /No jobs with status=new/);
    const show = await bot(['show', id, '--full']);
    assert.match(show, /Visa: UAE: employer issues work visa/);
    assert.match(show, /Laravel, PHP, Vue\.js/);
    assert.match(await bot(['stats']), /new\s+AE\s+1/);
    assert.match(await bot(['show', 'nope']), /Not found/);
  });

  it('mark changes status with history and rejects bad input', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.match(await bot(['mark', id, 'applied', 'via', 'Bayt']), /→ applied/);
    const { rows } = await pool.query('SELECT to_status, note FROM job_events WHERE job_id = $1', [id]);
    assert.deepEqual(rows, [{ to_status: 'applied', note: 'via Bayt' }]);
    assert.match(await bot(['mark', id, 'hired']), /Usage: mark/);
  });

  it('prepare writes the default CV path and an AI cover letter, never applies', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const letter = 'Dear Testco Cli Hiring Team,\nAI letter';
    const out = await bot(['prepare', id], { FAKE_CLAUDE_OUT: JSON.stringify({ letter }) });
    assert.match(out, /CV version : default/);
    assert.match(out, /written by AI/);
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      assert.equal(readFileSync(join(dir, 'cover-letter.txt'), 'utf8'), `${letter}\n`);
      const meta = JSON.parse(readFileSync(join(dir, 'application.json'), 'utf8'));
      assert.match(meta.cvFile, /cv\/default\/abdulrehman_dar_resume\.pdf$/);
      const j = await getJob(id);
      assert.equal(j.status, 'prepared');
      assert.equal(j.cover_letter_ai, true);
      assert.equal(j.applied_at, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prepare falls back to the template letter when AI fails', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const out = await bot(['prepare', id], { FAKE_CLAUDE_FAIL: 'offline' });
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    rmSync(dir, { recursive: true, force: true });
    assert.match(out, /AI cover letter failed, using template/);
    assert.match((await getJob(id)).cover_letter!, /^Dear Testco Cli Hiring Team,/);
    assert.equal((await getJob(id)).cover_letter_ai, false);
  });

  it('ai:score stores the review', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const review = { score: 87, verdict: 'strong', summary: 'Apply', reasons: ['Laravel'], gaps: [], red_flags: ['Arabic plus'] };
    assert.match(await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: JSON.stringify(review) }), /87 strong/);
    const j = await getJob(id) as unknown as Record<string, unknown>;
    assert.equal(j.ai_score, 87);
    assert.deepEqual(j.ai_flags, ['Arabic plus']);
    assert.match(await bot(['ai:score']), /Nothing to score/);
  });

  it('answer drafts, replaces re-asked questions, and clears', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const q = join(tmp, 'q.txt');
    writeFileSync(q, 'Notice period?\nYears with Laravel?');
    const first = [
      { question: 'Notice period?', answer: '[FILL: notice period]', needs_input: true, note: '' },
      { question: 'Years with Laravel?', answer: 'about 7 years', needs_input: false, note: '' },
    ];
    const out = await bot(['answer', id, '--file', q], { FAKE_CLAUDE_OUT: JSON.stringify({ answers: first }) });
    assert.match(out, /A: about 7 years/);
    assert.match(out, /1 answer\(s\) need your input/);

    const again = [{ question: 'notice period', answer: '1 month', needs_input: false, note: '' }];
    await bot(['answer', id], { FAKE_CLAUDE_OUT: JSON.stringify({ answers: again }) }, 'Notice period');
    assert.deepEqual((await getJob(id)).form_answers.map((a) => a.answer), ['about 7 years', '1 month']);

    assert.match(await bot(['answer', id, '--clear']), /Answers cleared/);
    assert.deepEqual((await getJob(id)).form_answers, []);
    assert.match(await bot(['answer', id], {}, '  '), /No questions given/);
  });

  it('rescore re-applies the filters without downloading', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await pool.query(`UPDATE jobs SET posted_at = now() - interval '40 days' WHERE id = $1`, [id]);
    assert.match(await bot(['rescore']), /1 jobs re-scored/);
    assert.match((await getJob(id)).filter_reason!, /posted 40 days ago/);
  });

  it('groups duplicates after adding', async () => {
    const out = await bot(['add', '--file', addFile([posting(), posting({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1/' })])]);
    assert.match(out, /1 duplicate postings grouped/);
  });

  it('prints help for unknown commands', async () => {
    assert.match(await bot(['nope']), /Commands:[\s\S]*answer <id>/);
  });
});
