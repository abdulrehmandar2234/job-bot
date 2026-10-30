import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { path } from '../src/config.ts';
import { AI_FAILED, runDaily } from '../src/commands/daily.ts';
import type { Note } from '../src/notify.ts';

// config.json `ai.enabled: false`: the AI-only commands say so and exit 0 without calling the provider, so a
// dashboard task or the daily run does not count them as failures. The fake Claude logs any call it gets.
const FAKE_CLAUDE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-ai-off-'));
const run = promisify(execFile);
const claudeLog = join(tmp, 'claude.jsonl');

// A temp copy of config.json with the AI off.
const configFile = join(tmp, 'config.json');
const cfg = JSON.parse(readFileSync(path('config.json'), 'utf8'));
cfg.ai.enabled = false;
writeFileSync(configFile, JSON.stringify(cfg));

/** Runs the CLI with the AI off; returns the exit code and output, failing or not. */
async function bot(args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
      cwd: path(),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB,
        JOB_BOT_CONFIG: configFile,
        JOB_BOT_CLAUDE: FAKE_CLAUDE,
        FAKE_CLAUDE_LOG: claudeLog,
        FAKE_CLAUDE_OUT: '{}',
        JOB_BOT_MASTER: path('cv', 'master.example.json'),
      },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function insertJob(id: string) {
  await pool.query(
    `INSERT INTO jobs (id, source, company, title, location, country, url, description, status, score, cv_version)
     VALUES ($1, 'greenhouse', 'Acme', 'Senior React Developer', 'Dubai', 'AE', $2, 'React and Node.js.', 'new', 70, 'default')`,
    [id, `https://example.com/${id}`],
  );
  return id;
}

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE');
  rmSync(claudeLog, { force: true });
});
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('ai.enabled false', () => {
  it('ai:score says the AI is off, exits 0 and reviews nothing', async () => {
    const id = await insertJob('off:score');
    const r = await bot(['ai:score']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^AI is off \(config\.json ai\.enabled\), so no jobs were AI-reviewed\.$/m);
    assert.equal((await getJob(id))!.ai_scored_at, null);
    // --id too (the dashboard's "AI review" task).
    assert.equal((await bot(['ai:score', '--id', id])).code, 0);
    assert.ok(!existsSync(claudeLog), 'the provider was never called');
  });

  it('answer says the AI is off and stores nothing; --clear still works', async () => {
    const id = await insertJob('off:answer');
    const q = join(tmp, 'questions.txt');
    writeFileSync(q, 'Why do you want to work with us?');
    const r = await bot(['answer', id, '--file', q]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /AI is off \(config\.json ai\.enabled\), so no answers were drafted\./);
    assert.deepEqual((await getJob(id))!.form_answers, []);
    assert.match((await bot(['answer', id, '--clear'])).stdout, /Answers cleared/);
    assert.ok(!existsSync(claudeLog), 'the provider was never called');
  });

  it('cv:feedback and cv:review say the AI is off, exit 0 and change nothing', async () => {
    const id = await insertJob('off:cv');
    const fb = await bot(['cv:feedback', id, '--feedback', 'shorter']);
    assert.equal(fb.code, 0);
    assert.match(fb.stdout, /AI is off \(config\.json ai\.enabled\): improving the CV with feedback needs it, so the CV is unchanged\./);
    const review = await bot(['cv:review', id]);
    assert.equal(review.code, 0);
    assert.match(review.stdout, /AI is off \(config\.json ai\.enabled\): the CV review is written by the AI, so there is none\./);
    const j = await getJob(id);
    assert.deepEqual([j!.cv_version, j!.cv_review], ['default', null]);
    assert.ok(!existsSync(claudeLog), 'the provider was never called');
  });
});

describe('bot daily with the AI off', () => {
  it('does not report the skipped AI review as a failure (the real ai:score, the other steps faked)', async () => {
    await insertJob('off:daily');
    const notes: Note[] = [];
    await runDaily({
      run: async (args) => {
        if (args[0] !== 'ai:score') return { code: 0, output: args[0] === 'fetch' ? '5 postings checked, 1 new.\n' : '' };
        const r = await bot(args);
        return { code: r.code, output: r.stdout + r.stderr };
      },
      notify: async (n) => {
        notes.push(n);
      },
      log: () => {},
    });
    assert.equal(notes[0].message, '5 postings checked, 1 new.');
    assert.doesNotMatch(notes[0].message, new RegExp(AI_FAILED.replace(/[()?]/g, '\\$&')));
  });
});
