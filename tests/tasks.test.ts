import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type ExecFileException, execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { dataPath, path } from '../src/settings.ts';
import {
  claim,
  cliArgs,
  CvBusyError,
  DEAD_WORKER_ERROR,
  DEADLINE_GRACE_MS,
  enqueue,
  expireStale,
  FEEDBACK_CAP,
  fail,
  failDeadWorkers,
  finish,
  KEEP_FINISHED_DAYS,
  OUTPUT_CAP,
  pidAlive,
  pruneFinished,
  TASK_TIMEOUT_MS,
} from '../src/tasks.ts';
import type { Task, TaskKind } from '../src/types.ts';
import { AI_BUDGET } from '../src/ai-providers.ts';
import { failureMessage } from '../src/commands/task.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const run = promisify(execFile);
const JOB = 'tasktest:1';

/** Runs `task:run <id>` through the real CLI, as the dashboard's detached worker does. */
async function taskRun(id: number | string, env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--no-warnings', 'src/cli.ts', 'task:run', String(id)], {
    cwd: path(),
    env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE, ...env },
    timeout: 60_000,
  });
  return stdout;
}

const getTask = async (id: number) => (await pool.query<Task>('SELECT * FROM tasks WHERE id = $1', [id])).rows[0];
const addJob = (id = JOB) =>
  pool.query(
    `INSERT INTO jobs (id, source, company, title, country, url, status, score, description)
  VALUES ($1, 'greenhouse', 'Taskco', 'Senior Laravel Developer', 'AE', 'https://example.com/' || $1, 'new', 60,
  'Laravel, PHP, Vue.js and MySQL.')`,
    [id],
  );

before(migrate);
beforeEach(async () => {
  await pool.query('TRUNCATE jobs, job_events, fetch_runs, tasks CASCADE');
  await addJob();
});
after(() => pool.end());

describe('task queue', () => {
  it('enqueue, claim, finish', async () => {
    const { task, created } = await enqueue('prepare', JOB, { cv: 'laravel' });
    assert.equal(created, true);
    assert.equal(task.status, 'queued');
    assert.deepEqual(task.args, { cv: 'laravel' });

    const claimed = await claim(task.id);
    assert.equal(claimed!.status, 'running');
    assert.equal(claimed!.pid, process.pid);
    const ms = claimed!.deadline!.getTime() - claimed!.started_at!.getTime();
    assert.equal(ms, TASK_TIMEOUT_MS.prepare + DEADLINE_GRACE_MS);
    assert.equal(await claim(task.id), null, 'a task is claimed once');

    await finish(task.id, 'x'.repeat(OUTPUT_CAP + 500) + 'END');
    const done = await getTask(task.id);
    assert.equal(done.status, 'done');
    assert.ok(done.finished_at);
    assert.equal(done.output!.length, OUTPUT_CAP + 1);
    assert.ok(done.output!.endsWith('END'), 'keeps the tail of the output');
  });

  it('fail stores the error and output', async () => {
    const { task } = await enqueue('ai_review', JOB);
    await claim(task.id);
    await fail(task.id, 'claude CLI missing', 'partial');
    assert.deepEqual((({ status, error, output }) => ({ status, error, output }))(await getTask(task.id)), {
      status: 'failed',
      error: 'claude CLI missing',
      output: 'partial',
    });
  });

  it('a fetch timeout is longer than a job task timeout', async () => {
    const { task } = await enqueue('fetch', null);
    const t = (await claim(task.id))!;
    assert.equal(t.deadline!.getTime() - t.started_at!.getTime(), TASK_TIMEOUT_MS.fetch + DEADLINE_GRACE_MS);
  });

  it('every kind that calls the AI outlives the overall AI budget with margin, so the real error is recorded', () => {
    const aiKinds: TaskKind[] = ['ai_review', 'answers', 'prep', 'follow_up', 'letter', 'summary', 'headline', 'cv_feedback', 'cv_review'];
    for (const kind of aiKinds) assert.ok(TASK_TIMEOUT_MS[kind] >= AI_BUDGET.ms + 60_000, `${kind} must exceed the AI budget with margin`);
  });

  it('interview prep is a task kind with a 6 minute timeout (migration 007)', async () => {
    assert.equal(TASK_TIMEOUT_MS.prep, 6 * 60_000);
    const { task } = await enqueue('prep', JOB);
    const t = (await claim(task.id))!;
    assert.equal(t.deadline!.getTime() - t.started_at!.getTime(), TASK_TIMEOUT_MS.prep + DEADLINE_GRACE_MS);
  });

  it('drafting a follow-up is a task kind with a 6 minute timeout (migration 008)', async () => {
    assert.equal(TASK_TIMEOUT_MS.follow_up, 6 * 60_000);
    const { task, created } = await enqueue('follow_up', JOB);
    assert.equal(created, true);
    assert.equal(task.kind, 'follow_up');
  });

  it('a CV summary and a tailored CV are task kinds (migration 013)', async () => {
    assert.deepEqual([TASK_TIMEOUT_MS.summary, TASK_TIMEOUT_MS.tailored_cv], [6 * 60_000, 4 * 60_000]);
    for (const kind of ['summary', 'tailored_cv'] as const) {
      const { task, created } = await enqueue(kind, JOB, kind === 'summary' ? { feedback: 'shorter' } : {});
      assert.equal(created, true);
      assert.equal(task.kind, kind);
    }
  });

  it('applying a CV template, improving the CV with feedback and a CV review are task kinds (migration 014)', async () => {
    assert.deepEqual(
      [TASK_TIMEOUT_MS.cv_template, TASK_TIMEOUT_MS.cv_feedback, TASK_TIMEOUT_MS.cv_review],
      [4 * 60_000, 6 * 60_000, 6 * 60_000],
    );
    const args = { cv_template: { template: 'modern' }, cv_feedback: { feedback: 'shorter' }, cv_review: {} };
    for (const kind of ['cv_template', 'cv_feedback', 'cv_review'] as const) {
      const { task, created } = await enqueue(kind, JOB, args[kind]);
      assert.equal(created, true);
      assert.deepEqual([task.kind, task.args], [kind, args[kind]]);
      await finish(task.id, ''); // CV-changing kinds run one at a time per job
    }
  });

  it('one CV change per job: another CV-changing kind is refused while one is active (the rule the dashboard uses)', async () => {
    await addJob('tasktest:2');
    const { task } = await enqueue('prepare', JOB);
    await assert.rejects(enqueue('cv_template', JOB, { template: 'modern' }), CvBusyError);
    assert.equal((await enqueue('prepare', JOB)).created, false); // the same kind is the same work, not refused
    assert.equal((await enqueue('letter', JOB)).created, true); // a letter does not change the CV
    assert.equal((await enqueue('cv_template', 'tasktest:2', { template: 'modern' })).created, true); // another job
    await finish(task.id, '');
    assert.equal((await enqueue('cv_template', JOB, { template: 'modern' })).created, true);
  });

  it('rejects unknown kinds and jobs at the database', async () => {
    await assert.rejects(enqueue('bogus' as 'fetch', null), /tasks_kind_check/);
    await assert.rejects(enqueue('prepare', 'tasktest:nope'), /foreign key/);
  });

  it('deleting a job deletes its tasks', async () => {
    const { task } = await enqueue('prepare', JOB);
    await pool.query('DELETE FROM jobs WHERE id = $1', [JOB]);
    assert.equal(await getTask(task.id), undefined);
  });
});

describe('duplicate guard', () => {
  it('returns the queued or running fetch instead of starting another', async () => {
    const a = await enqueue('fetch', null);
    const b = await enqueue('fetch', null);
    assert.equal(b.created, false);
    assert.equal(b.task.id, a.task.id);
    await claim(a.task.id);
    assert.equal((await enqueue('fetch', null)).task.id, a.task.id);
    await finish(a.task.id, '');
    const c = await enqueue('fetch', null);
    assert.equal(c.created, true);
    assert.notEqual(c.task.id, a.task.id);
  });

  it('allows one task per (kind, job)', async () => {
    await addJob('tasktest:2');
    const a = await enqueue('prepare', JOB);
    assert.equal((await enqueue('prepare', JOB, { cv: 'other' })).task.id, a.task.id);
    assert.equal((await enqueue('answers', JOB, { questions: 'Why?' })).created, true);
    assert.equal((await enqueue('prepare', 'tasktest:2')).created, true);
    await fail(a.task.id, 'boom');
    assert.equal((await enqueue('prepare', JOB)).created, true, 'a failed task does not block a retry');
  });

  it('holds under concurrent clicks', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => enqueue('ai_review', JOB)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.task.id)).size, 1);
  });
});

describe('stale tasks', () => {
  it('fails a running task past its deadline and a queued task nobody claimed', async () => {
    const running = (await enqueue('fetch', null)).task;
    const queued = (await enqueue('prepare', JOB)).task;
    const fresh = (await enqueue('ai_review', JOB)).task;
    const live = (await enqueue('answers', JOB, { questions: 'Q' })).task;
    await claim(running.id);
    await claim(live.id);
    await pool.query(`UPDATE tasks SET deadline = now() - interval '1 second' WHERE id = $1`, [running.id]);
    await pool.query(`UPDATE tasks SET created_at = now() - interval '3 minutes' WHERE id = $1`, [queued.id]);

    assert.equal(await expireStale(), 2);
    assert.equal((await getTask(running.id)).status, 'failed');
    assert.match((await getTask(running.id)).error!, /Timed out/);
    assert.match((await getTask(queued.id)).error!, /never started/);
    assert.equal((await getTask(fresh.id)).status, 'queued');
    assert.equal((await getTask(live.id)).status, 'running');
    assert.equal(await expireStale(), 0);
  });

  it('enqueue expires a dead task first, so it never blocks new work', async () => {
    const dead = (await enqueue('fetch', null)).task;
    await claim(dead.id);
    await pool.query(`UPDATE tasks SET deadline = now() - interval '1 second' WHERE id = $1`, [dead.id]);
    const next = await enqueue('fetch', null);
    assert.equal(next.created, true);
    assert.equal((await getTask(dead.id)).status, 'failed');
  });

  it('a worker that comes back after expiry still records its result', async () => {
    const t = (await enqueue('prepare', JOB)).task;
    await claim(t.id);
    await pool.query(`UPDATE tasks SET deadline = now() - interval '1 second' WHERE id = $1`, [t.id]);
    await expireStale();
    await finish(t.id, 'ok');
    assert.equal((await getTask(t.id)).status, 'done');
    assert.equal((await getTask(t.id)).error, null);
  });
});

/** The pid of a process that has exited (and been reaped), so nothing answers to it. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

describe('dead workers', () => {
  it('pidAlive: our own process and one we may not signal are alive, an exited one is not', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(1), true, 'launchd: EPERM means it exists');
    assert.equal(pidAlive(deadPid()), false);
  });

  it('fails a running task whose worker pid is gone, before its deadline', async () => {
    const dead = (await enqueue('prepare', JOB)).task;
    const live = (await enqueue('ai_review', JOB)).task;
    const queued = (await enqueue('fetch', null)).task;
    await claim(dead.id);
    await claim(live.id);
    await pool.query('UPDATE tasks SET pid = $2 WHERE id = $1', [dead.id, deadPid()]);

    assert.equal(await failDeadWorkers(), 1);
    assert.deepEqual((({ status, error }) => ({ status, error }))(await getTask(dead.id)), { status: 'failed', error: DEAD_WORKER_ERROR });
    assert.ok((await getTask(dead.id)).finished_at);
    assert.equal((await getTask(live.id)).status, 'running');
    assert.equal((await getTask(queued.id)).status, 'queued', 'a queued task has no worker yet');
    assert.equal(await failDeadWorkers(), 0);
  });

  it('enqueue fails a dead worker first, so the same work can start again at once', async () => {
    const dead = (await enqueue('prep', JOB)).task;
    await claim(dead.id);
    await pool.query('UPDATE tasks SET pid = $2 WHERE id = $1', [dead.id, deadPid()]);
    const next = await enqueue('prep', JOB);
    assert.equal(next.created, true);
    assert.equal((await getTask(dead.id)).status, 'failed');
  });

  it('expireStale counts dead workers too', async () => {
    const dead = (await enqueue('prepare', JOB)).task;
    await claim(dead.id);
    await pool.query('UPDATE tasks SET pid = $2 WHERE id = $1', [dead.id, deadPid()]);
    assert.equal(await expireStale(), 1);
  });
});

describe('pruning', () => {
  it(`deletes done and failed tasks older than ${KEEP_FINISHED_DAYS} days, nothing else`, async () => {
    const add = async (status: string, age: number) =>
      (
        await pool.query<{ id: number }>(
          `INSERT INTO tasks (kind, job_id, status, created_at, finished_at)
       VALUES ('prepare', $1, $2, now() - make_interval(days => $3), CASE WHEN $2 IN ('done', 'failed') THEN now() - make_interval(days => $3) END)
       RETURNING id`,
          [JOB, status, age],
        )
      ).rows[0].id;
    const oldDone = await add('done', KEEP_FINISHED_DAYS + 1);
    const oldFailed = await add('failed', KEEP_FINISHED_DAYS + 5);
    const recent = await add('done', KEEP_FINISHED_DAYS - 1);
    await pool.query(
      `INSERT INTO tasks (kind, status, created_at, started_at, deadline, pid)
      VALUES ('fetch', 'running', now() - interval '40 days', now(), now() + interval '1 hour', $1)`,
      [process.pid],
    );

    assert.equal(await pruneFinished(), 2);
    const left = (await pool.query<Task>('SELECT * FROM tasks ORDER BY id')).rows;
    assert.ok(!left.some((t) => t.id === oldDone || t.id === oldFailed));
    assert.ok(left.some((t) => t.id === recent));
    assert.ok(
      left.some((t) => t.kind === 'fetch' && t.status === 'running'),
      'an old running task is not pruned',
    );
  });

  it('enqueue prunes', async () => {
    await pool.query(`INSERT INTO tasks (kind, status, created_at, finished_at)
      VALUES ('rescore', 'done', now() - interval '60 days', now() - interval '60 days')`);
    await enqueue('fetch', null);
    assert.equal((await pool.query(`SELECT 1 FROM tasks WHERE kind = 'rescore'`)).rowCount, 0);
  });
});

describe('cliArgs', () => {
  const t = (kind: Task['kind'], args: Record<string, string> = {}, job_id: string | null = JOB) => ({ kind, job_id, args });

  it('cv_import runs cv:import on its uploaded file, and only on a file in data/cv-import', () => {
    const file = dataPath('cv-import', 'upload.pdf');
    assert.deepEqual(cliArgs(t('cv_import', { file }, null)), ['cv:import', file]);
    assert.deepEqual(cliArgs(t('cv_import', { file, name: '../My CV --apply.pdf' }, null)), [
      'cv:import',
      file,
      '--name=My CV --apply.pdf',
    ]);
    const bad: Record<string, string>[] = [
      {},
      { file: '/etc/passwd' },
      { file: dataPath('upload.pdf') },
      { file: dataPath('cv-import', 'x', 'upload.pdf') },
    ];
    for (const args of bad) assert.throws(() => cliArgs(t('cv_import', args, null)), /without its uploaded file/);
  });

  it('maps each kind to its CLI command', () => {
    assert.deepEqual(cliArgs(t('fetch', {}, null)), ['fetch']);
    assert.deepEqual(cliArgs(t('rescore', {}, null)), ['rescore']);
    assert.deepEqual(cliArgs(t('ai_review')), ['ai:score', '--id', JOB]);
    assert.deepEqual(cliArgs(t('prepare')), ['prepare', JOB]);
    assert.deepEqual(cliArgs(t('prepare', { cv: 'backend-lead-2' })), ['prepare', JOB, '--cv', 'backend-lead-2']);
    assert.deepEqual(cliArgs(t('answers', { questions: 'Q' }), '/tmp/q.txt'), ['answer', JOB, '--file', '/tmp/q.txt']);
    assert.deepEqual(cliArgs(t('prep')), ['prep', JOB]);
    assert.deepEqual(cliArgs(t('follow_up')), ['follow-up', JOB]);
    assert.deepEqual(cliArgs(t('letter')), ['letter', JOB]);
    assert.deepEqual(cliArgs(t('summary')), ['summary', JOB]);
    assert.deepEqual(cliArgs(t('headline')), ['headline', JOB]);
    assert.deepEqual(cliArgs(t('headline', { feedback: ' shorter ' })), ['headline', JOB, '--feedback=shorter']);
    assert.deepEqual(cliArgs(t('tailored_cv')), ['cv:tailor', JOB]);
    assert.deepEqual(cliArgs(t('cv_template', { template: 'compact' })), ['cv:template', JOB, 'compact']);
    assert.deepEqual(cliArgs(t('cv_feedback', { feedback: '  put Laravel first ' })), ['cv:feedback', JOB, '--feedback=put Laravel first']);
    assert.deepEqual(cliArgs(t('cv_review')), ['cv:review', JOB]);
  });

  it('runs cv:template only with a known template name', () => {
    for (const template of ['', 'Modern', 'fancy', '--pdf', '../classic', undefined])
      assert.throws(
        () => cliArgs({ kind: 'cv_template', job_id: JOB, args: { template } as unknown as Record<string, string> }),
        /Unknown CV template/,
      );
    assert.throws(() => cliArgs(t('cv_template', { template: 'modern' }, null)), /cv_template task without a job/);
  });

  it('runs cv:feedback only with feedback of at most 1000 characters', () => {
    for (const feedback of ['', '   '])
      assert.throws(() => cliArgs(t('cv_feedback', { feedback })), /Write what should change in the CV first/);
    assert.throws(() => cliArgs(t('cv_feedback')), /Write what should change in the CV first/);
    assert.throws(() => cliArgs(t('cv_feedback', { feedback: 'x'.repeat(FEEDBACK_CAP + 1) })), /Feedback is too long/);
    assert.deepEqual(cliArgs(t('cv_feedback', { feedback: '--template; rm -rf ~' })), [
      'cv:feedback',
      JOB,
      '--feedback=--template; rm -rf ~',
    ]);
  });

  it('runs cv:feedback with confirmed skills, with or without feedback, and only known skill names', () => {
    assert.deepEqual(cliArgs(t('cv_feedback', { skills: 'Docker,GraphQL' })), ['cv:feedback', JOB, '--add-skills=Docker,GraphQL']);
    assert.deepEqual(cliArgs(t('cv_feedback', { skills: 'Docker', feedback: 'used it at work' })), [
      'cv:feedback',
      JOB,
      '--feedback=used it at work',
      '--add-skills=Docker',
    ]);
    assert.throws(() => cliArgs(t('cv_feedback', { skills: 'Docker,--template' })), /Unknown skill: --template/);
    assert.throws(() => cliArgs(t('cv_feedback', { skills: '' })), /needs skill names/);
  });

  it('passes feedback to letter and summary as one --feedback=<text> argument, trimmed', () => {
    assert.deepEqual(cliArgs(t('letter', { feedback: '  shorter  ' })), ['letter', JOB, '--feedback=shorter']);
    assert.deepEqual(cliArgs(t('summary', { feedback: 'less formal\nmention Laravel' })), [
      'summary',
      JOB,
      '--feedback=less formal\nmention Laravel',
    ]);
    // Text that looks like a flag stays the value, and nothing goes through a shell.
    assert.deepEqual(cliArgs(t('letter', { feedback: '--template; rm -rf ~' })), ['letter', JOB, '--feedback=--template; rm -rf ~']);
    assert.deepEqual(cliArgs(t('letter', { feedback: 'x'.repeat(FEEDBACK_CAP) })), [
      'letter',
      JOB,
      `--feedback=${'x'.repeat(FEEDBACK_CAP)}`,
    ]);
    for (const feedback of ['', '   ']) assert.deepEqual(cliArgs(t('summary', { feedback })), ['summary', JOB]);
    assert.deepEqual(cliArgs(t('tailored_cv', { feedback: 'ignored' })), ['cv:tailor', JOB]);
  });

  it('refuses feedback that is too long or not text', () => {
    assert.equal(FEEDBACK_CAP, 1000);
    for (const kind of ['letter', 'summary'] as const) {
      assert.throws(() => cliArgs(t(kind, { feedback: 'x'.repeat(FEEDBACK_CAP + 1) })), /Feedback is too long \(at most 1000 characters\)/);
      for (const feedback of [42, ['shorter'], { a: 1 }, null, true])
        assert.throws(
          () => cliArgs({ kind, job_id: JOB, args: { feedback } as unknown as Record<string, string> }),
          /Feedback must be text/,
        );
    }
  });

  it('passes --force to prepare only for force "true" ("Prepare anyway" on an expired job)', () => {
    assert.deepEqual(cliArgs(t('prepare', { force: 'true' })), ['prepare', JOB, '--force']);
    assert.deepEqual(cliArgs(t('prepare', { cv: 'laravel', force: 'true' })), ['prepare', JOB, '--cv', 'laravel', '--force']);
    for (const force of ['false', '1', '--cv x', '']) assert.deepEqual(cliArgs(t('prepare', { force })), ['prepare', JOB]);
  });

  it('drops an invalid CV version and refuses a job task without a job', () => {
    for (const cv of ['../x', 'Backend', '--help', 'a b', '']) assert.deepEqual(cliArgs(t('prepare', { cv })), ['prepare', JOB]);
    assert.throws(() => cliArgs(t('prepare', {}, null)), /without a job/);
    assert.throws(() => cliArgs(t('answers')), /questions file/);
  });
});

describe('task:run (CLI worker)', () => {
  it('runs a prepare task and marks it done; the letter is left for a letter task', async () => {
    const { task } = await enqueue('prepare', JOB);
    const out = await taskRun(task.id, { FAKE_CLAUDE_FAIL: 'prepare must not call the AI' });
    assert.match(out, new RegExp(`task ${task.id}: done`));
    const done = await getTask(task.id);
    assert.equal(done.status, 'done');
    assert.notEqual(done.pid, process.pid);
    assert.match(done.output!, /CV version : default/);
    assert.match(done.output!, /Cover {6}: not written yet/);
    const job = await getJob(JOB);
    assert.deepEqual([job!.status, job!.cover_letter], ['prepared', null]);
  });

  it('runs a letter task with the fake Claude and stores the letter', async () => {
    const { task } = await enqueue('letter', JOB);
    const letter = 'Dear Taskco Hiring Team,\nTask letter';
    const out = await taskRun(task.id, { FAKE_CLAUDE_OUT: JSON.stringify({ letter }) });
    assert.match(out, new RegExp(`task ${task.id}: done`));
    const done = await getTask(task.id);
    const dir = done.output!.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    rmSync(dir, { recursive: true, force: true });
    assert.equal((await getJob(JOB))!.cover_letter, `${letter}\n`);
    assert.equal(TASK_TIMEOUT_MS.letter, 6 * 60_000);
  });

  it('runs a summary task with feedback through the worker; feedback starting with "--" stays the text', async () => {
    await pool.query(`UPDATE jobs SET cv_summary = 'Old summary.' WHERE id = $1`, [JOB]);
    const log = join(mkdtempSync(join(tmpdir(), 'jobbot-task-sum-')), 'calls.jsonl');
    const { task } = await enqueue('summary', JOB, { feedback: '--shorter please' });
    await taskRun(task.id, { FAKE_CLAUDE_OUT: JSON.stringify({ summary: 'New summary.', note: 'Kept to the CV.' }), FAKE_CLAUDE_LOG: log });
    const done = await getTask(task.id);
    assert.equal(done.status, 'done');
    assert.match(done.output!, /Note {7}: Kept to the CV\./);
    assert.equal((await getJob(JOB))!.cv_summary, 'New summary.');
    const [{ stdin }] = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { stdin: string });
    assert.match(stdin, /CURRENT SUMMARY:\nOld summary\.\n\nFEEDBACK FROM THE CANDIDATE:\n--shorter please$/);
  });

  it('a task with too-long feedback fails with the reason and changes nothing', async () => {
    const { task } = await enqueue('letter', JOB, { feedback: 'x'.repeat(FEEDBACK_CAP + 1) });
    await taskRun(task.id, { FAKE_CLAUDE_FAIL: 'must not call the AI' });
    const failed = await getTask(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /Feedback is too long/);
    assert.equal((await getJob(JOB))!.cover_letter, null);
  });

  it('runs an answers task from args and removes the questions file', async () => {
    const dir = dataPath('questions');
    const files = () => (existsSync(dir) ? readdirSync(dir) : []);
    const before = files();
    const { task } = await enqueue('answers', JOB, { questions: '  Notice period?  ' });
    const answers = [{ question: 'Notice period?', answer: 'One month', needs_input: false, note: '' }];
    await taskRun(task.id, { FAKE_CLAUDE_OUT: JSON.stringify({ answers }) });

    assert.equal((await getTask(task.id)).status, 'done');
    assert.deepEqual((await getJob(JOB))!.form_answers, answers);
    assert.deepEqual(files(), before);
  });

  it('runs a prep task and stores the interview notes on the job', async () => {
    const prep = {
      technical: [{ question: 'How do you scale a Laravel queue?', hint: 'Horizon' }],
      behavioural: [{ question: 'A conflict?', situation: 'S', task: 'T', action: 'A', result: 'R' }],
      company: { brief: 'Taskco builds things.', verify: [] },
      questions_to_ask: ['How do you review code?'],
      requirements: [{ requirement: 'Laravel', evidence: 'Years of Laravel', gap: false }],
    };
    const { task } = await enqueue('prep', JOB);
    await taskRun(task.id, { FAKE_CLAUDE_OUT: JSON.stringify(prep) });
    const done = await getTask(task.id);
    assert.equal(done.status, 'done', done.error ?? '');
    assert.match(done.output!, /1 technical and 1 behavioural questions/);
    assert.deepEqual((await getJob(JOB))!.interview_prep, prep);
  });

  it('records a failing command as failed with its error', async () => {
    const { task } = await enqueue('answers', JOB, { questions: 'Why us?' });
    await taskRun(task.id, { FAKE_CLAUDE_FAIL: 'Claude is offline' });
    const failed = await getTask(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /Claude is offline/);
    assert.deepEqual((await getJob(JOB))!.form_answers, []);
  });

  it('records an AI review task as failed when Claude fails for that job', async () => {
    const { task } = await enqueue('ai_review', JOB);
    await taskRun(task.id, { FAKE_CLAUDE_FAIL: 'Not logged in' });
    const failed = await getTask(task.id);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error!, /AI review failed for 1 of 1 job: .*Not logged in/);
    assert.match(failed.output!, /0 jobs scored, 1 failed/);
    assert.equal((await getJob(JOB))!.ai_scored_at, null);
  });

  it('a task killed at its timeout keeps the last stderr line (the real error), with the key redacted', () => {
    const killed = (stderr?: string): ExecFileException & { stderr?: string } =>
      Object.assign(new Error('Command failed'), { cmd: 'bot', killed: true, stderr });
    assert.equal(failureMessage(killed(''), 6 * 60_000), 'Timed out after 6 minutes.');
    assert.equal(failureMessage(killed(undefined), 6 * 60_000), 'Timed out after 6 minutes.');
    assert.equal(
      failureMessage(killed('AI scoring 3 jobs...\nOpenAI gave no answer within the 300s AI budget\n\n'), 6 * 60_000),
      'Timed out after 6 minutes (last error: OpenAI gave no answer within the 300s AI budget)',
    );
    const saved = process.env.AI_API_KEY;
    process.env.AI_API_KEY = 'sk-task-secret-42';
    try {
      const msg = failureMessage(killed('request failed for sk-task-secret-42'), 6 * 60_000);
      assert.equal(msg, 'Timed out after 6 minutes (last error: request failed for ***)');
      // A child that failed on its own keeps its whole stderr, redacted the same way.
      assert.equal(
        failureMessage(
          Object.assign(new Error('Command failed'), { cmd: 'bot', stderr: 'bad key sk-task-secret-42\n' }) as ExecFileException & {
            stderr?: string;
          },
          60_000,
        ),
        'bad key ***',
      );
    } finally {
      if (saved === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = saved;
    }
  });

  it('fails an answers task without questions', async () => {
    const { task } = await enqueue('answers', JOB, {});
    await taskRun(task.id);
    assert.deepEqual((({ status, error }) => ({ status, error }))(await getTask(task.id)), {
      status: 'failed',
      error: 'No questions given.',
    });
  });

  it('does nothing for a task that is not queued, or a bad id', async () => {
    const { task } = await enqueue('ai_review', JOB);
    await claim(task.id);
    assert.match(await taskRun(task.id), /is not queued/);
    assert.equal((await getTask(task.id)).pid, process.pid);
    await assert.rejects(taskRun('abc'), (e: { code: number; stderr: string }) => e.code === 1 && /Usage: task:run <id>/.test(e.stderr));
  });
});
