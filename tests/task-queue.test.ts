import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  CV_CHANGES,
  CvBusyError,
  DEAD_WORKER_ERROR,
  type Db,
  enqueue,
  expireStale,
  failDeadWorkers,
  pruneFinished,
} from '../src/task-queue.ts';
import { KEEP_FINISHED_DAYS, type Task } from '../src/types.ts';

// src/task-queue.ts against a scripted stub Db, no PostgreSQL: the branches a real database rarely hits (a task that
// finishes between the insert and the lookup, three such races in a row) run on demand. The SQL itself is covered by
// the dashboard's web/tests/lib/tasks.test.ts against the test database.

type Result = { rows: any[]; rowCount: number | null };
type Call = { text: string; values?: unknown[] };

/** A Db that answers each query with the first handler whose pattern matches its SQL, and records every call. */
function stubDb(handlers: [RegExp, (values?: unknown[]) => Result][]): Db & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const handler = handlers.find(([re]) => re.test(text));
      if (!handler) throw new Error(`unexpected query: ${text}`);
      return handler[1](values) as any;
    },
  };
}

const rows = (r: any[]): Result => ({ rows: r, rowCount: r.length });
const task = (over: Partial<Task> = {}) => ({ id: 1, kind: 'prepare', job_id: 'job:1', status: 'queued', ...over }) as Task;
/** No running tasks, nothing stale, nothing to prune: what enqueue's housekeeping sees on a quiet queue. */
const quiet: [RegExp, (values?: unknown[]) => Result][] = [
  [/^SELECT id, pid FROM tasks/, () => rows([])],
  [/expire_stale_tasks/, () => rows([{ n: 0 }])],
  [/^DELETE FROM tasks/, () => ({ rows: [], rowCount: 0 })],
];
const inserts = (db: { calls: Call[] }) => db.calls.filter((c) => c.text.startsWith('INSERT')).length;

afterEach(() => mock.restoreAll());

describe('enqueue', () => {
  it('creates the task when the insert returns a row', async () => {
    const created = task({ id: 7 });
    const db = stubDb([...quiet, [/^INSERT/, () => rows([created])]]);
    assert.deepEqual(await enqueue(db, 'fetch', null), { task: created, created: true });
    const insert = db.calls.find((c) => c.text.startsWith('INSERT'))!;
    assert.deepEqual(insert.values, ['fetch', null, '{}']); // not a CV change: no CV_CHANGES parameter
  });

  it('returns the active task when the insert conflicts with the same work', async () => {
    const active = task({ id: 3, status: 'running' });
    const db = stubDb([...quiet, [/^INSERT/, () => rows([])], [/^SELECT \* FROM tasks/, () => rows([active])]]);
    assert.deepEqual(await enqueue(db, 'prepare', 'job:1'), { task: active, created: false });
  });

  it('a CV-changing kind passes CV_CHANGES to the insert, and is refused while another CV kind is active', async () => {
    const db = stubDb([
      ...quiet,
      [/^INSERT/, () => rows([])],
      [/^SELECT \* FROM tasks/, () => rows([])], // no task of this kind
      [/^SELECT 1 FROM tasks/, () => rows([{ '?column?': 1 }])], // but another CV-changing kind is active
    ]);
    await assert.rejects(enqueue(db, 'cv_template', 'job:1', { template: 'modern' }), CvBusyError);
    const insert = db.calls.find((c) => c.text.startsWith('INSERT'))!;
    assert.deepEqual(insert.values, ['cv_template', 'job:1', '{"template":"modern"}', [...CV_CHANGES]]);
    assert.equal(inserts(db), 1, 'refused at once, no retry');
  });

  it('tries the insert again when the active task finished between the queries, and succeeds on attempt 2', async () => {
    const created = task({ id: 9, kind: 'prepare' });
    let attempt = 0;
    const db = stubDb([
      ...quiet,
      [/^INSERT/, () => rows(++attempt === 1 ? [] : [created])],
      [/^SELECT \* FROM tasks/, () => rows([])], // the conflicting task is gone
      [/^SELECT 1 FROM tasks/, () => rows([])], // and no other CV kind is active
    ]);
    assert.deepEqual(await enqueue(db, 'prepare', 'job:1'), { task: created, created: true });
    assert.equal(inserts(db), 2);
  });

  it('gives up with "Could not start <what>" after three races', async () => {
    const db = stubDb([...quiet, [/^INSERT/, () => rows([])], [/^SELECT \* FROM tasks/, () => rows([])]]);
    await assert.rejects(enqueue(db, 'rescore', null, {}, 're-scoring jobs'), { message: 'Could not start re-scoring jobs' });
    assert.equal(inserts(db), 3);
    assert.ok(!db.calls.some((c) => c.text.startsWith('SELECT 1')), 'not a CV change: no CV check');
  });

  it('names the kind in the error by default', async () => {
    const db = stubDb([...quiet, [/^INSERT/, () => rows([])], [/^SELECT \* FROM tasks/, () => rows([])]]);
    await assert.rejects(enqueue(db, 'fetch', null), { message: 'Could not start the fetch task' });
  });

  it('expires stale tasks and prunes old ones before inserting', async () => {
    const db = stubDb([...quiet, [/^INSERT/, () => rows([task()])]]);
    await enqueue(db, 'fetch', null);
    const order = db.calls.map((c) => c.text.split(/\s/)[0] + (c.text.includes('expire_stale_tasks') ? ' expire' : ''));
    assert.deepEqual(order, ['SELECT', 'SELECT expire', 'DELETE', 'INSERT']);
  });
});

describe('failDeadWorkers', () => {
  const ALIVE = 1001;
  const OTHER_USER = 1002;
  const DEAD = 1003;
  /** process.kill(pid, 0) as the OS answers it: ESRCH for a dead pid, EPERM for one we may not signal. */
  const fakeKill = () =>
    mock.method(process, 'kill', (pid: number) => {
      const fail = (code: string) => Object.assign(new Error(code), { code });
      if (pid === DEAD) throw fail('ESRCH');
      if (pid === OTHER_USER) throw fail('EPERM');
      return true;
    });

  it('fails only the running tasks whose pid is dead, and returns the update count', async () => {
    fakeKill();
    const db = stubDb([
      [
        /^SELECT id, pid FROM tasks/,
        () =>
          rows([
            { id: 1, pid: ALIVE },
            { id: 2, pid: DEAD },
            { id: 3, pid: OTHER_USER },
          ]),
      ],
      [/^UPDATE tasks/, () => ({ rows: [], rowCount: 1 })],
    ]);
    assert.equal(await failDeadWorkers(db), 1);
    const update = db.calls.find((c) => c.text.startsWith('UPDATE'))!;
    assert.deepEqual(update.values, [[2], DEAD_WORKER_ERROR]);
    assert.match(update.text, /AND status = 'running'/, 'a worker that just recorded its result is left alone');
  });

  it('runs no update when every worker is alive', async () => {
    fakeKill();
    const db = stubDb([[/^SELECT id, pid FROM tasks/, () => rows([{ id: 1, pid: ALIVE }])]]);
    assert.equal(await failDeadWorkers(db), 0);
    assert.equal(db.calls.length, 1);
  });

  it('counts 0 when the update matched nothing (the worker finished first)', async () => {
    fakeKill();
    const db = stubDb([
      [/^SELECT id, pid FROM tasks/, () => rows([{ id: 2, pid: DEAD }])],
      [/^UPDATE tasks/, () => ({ rows: [], rowCount: null })],
    ]);
    assert.equal(await failDeadWorkers(db), 0);
  });
});

describe('expireStale and pruneFinished', () => {
  it('expireStale adds the dead workers to the tasks past their deadline', async () => {
    mock.method(process, 'kill', () => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const db = stubDb([
      [
        /^SELECT id, pid FROM tasks/,
        () =>
          rows([
            { id: 1, pid: 1 },
            { id: 2, pid: 2 },
          ]),
      ],
      [/^UPDATE tasks/, () => ({ rows: [], rowCount: 2 })],
      [/expire_stale_tasks/, () => rows([{ n: 3 }])],
    ]);
    assert.equal(await expireStale(db), 5);
  });

  it(`pruneFinished deletes with KEEP_FINISHED_DAYS (${KEEP_FINISHED_DAYS}) and returns the count`, async () => {
    const db = stubDb([[/^DELETE FROM tasks/, () => ({ rows: [], rowCount: 4 })]]);
    assert.equal(await pruneFinished(db), 4);
    assert.deepEqual(db.calls[0].values, [KEEP_FINISHED_DAYS]);
    assert.match(db.calls[0].text, /status IN \('done', 'failed'\)/);
  });
});
