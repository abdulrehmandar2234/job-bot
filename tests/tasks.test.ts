import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { path } from '../src/settings.ts';
import {
  claim,
  cliArgs,
  DEAD_WORKER_ERROR,
  DEADLINE_GRACE_MS,
  enqueue,
  expireStale,
  fail,
  failDeadWorkers,
  finish,
  KEEP_FINISHED_DAYS,
  OUTPUT_CAP,
  pidAlive,
  pruneFinished,
  TASK_TIMEOUT_MS,
} from '../src/tasks.ts';
import type { Task } from '../src/types.ts';

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

  it('interview prep is a task kind with a 4 minute timeout (migration 007)', async () => {
    assert.equal(TASK_TIMEOUT_MS.prep, 4 * 60_000);
    const { task } = await enqueue('prep', JOB);
    const t = (await claim(task.id))!;
    assert.equal(t.deadline!.getTime() - t.started_at!.getTime(), TASK_TIMEOUT_MS.prep + DEADLINE_GRACE_MS);
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

  it('maps each kind to its CLI command', () => {
    assert.deepEqual(cliArgs(t('fetch', {}, null)), ['fetch']);
    assert.deepEqual(cliArgs(t('rescore', {}, null)), ['rescore']);
    assert.deepEqual(cliArgs(t('ai_review')), ['ai:score', '--id', JOB]);
    assert.deepEqual(cliArgs(t('prepare')), ['prepare', JOB]);
    assert.deepEqual(cliArgs(t('prepare', { cv: 'backend-lead-2' })), ['prepare', JOB, '--cv', 'backend-lead-2']);
    assert.deepEqual(cliArgs(t('answers', { questions: 'Q' }), '/tmp/q.txt'), ['answer', JOB, '--file', '/tmp/q.txt']);
    assert.deepEqual(cliArgs(t('prep')), ['prep', JOB]);
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
  it('runs a prepare task with the fake Claude and marks it done', async () => {
    const { task } = await enqueue('prepare', JOB);
    const letter = 'Dear Taskco Hiring Team,\nTask letter';
    const out = await taskRun(task.id, { FAKE_CLAUDE_OUT: JSON.stringify({ letter }) });
    assert.match(out, new RegExp(`task ${task.id}: done`));

    const done = await getTask(task.id);
    assert.equal(done.status, 'done');
    assert.notEqual(done.pid, process.pid);
    assert.match(done.output!, /CV version : default/);
    const dir = done.output!.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    rmSync(dir, { recursive: true, force: true });
    const job = await getJob(JOB);
    assert.equal(job!.cover_letter, `${letter}\n`);
    assert.equal(job!.status, 'prepared');
  });

  it('runs an answers task from args and removes the questions file', async () => {
    const dir = path('data', 'questions');
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
    assert.match(await taskRun('abc'), /Usage: task:run <id>/);
  });
});
