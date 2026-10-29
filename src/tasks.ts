import { pool } from './db.ts';
import type { Task, TaskKind } from './types.ts';

// The background task queue (table `tasks`, src/migrations/002_tasks.sql).
// The dashboard enqueues (web/lib/tasks.ts, same SQL as enqueue() here) and spawns a detached `task:run <id>`
// (src/commands/task.ts), which claims the row, runs the normal CLI command and stores the result.

/** How long each kind may run before the worker kills it. */
export const TASK_TIMEOUT_MS: Record<TaskKind, number> = {
  fetch: 20 * 60_000,
  prepare: 4 * 60_000,
  ai_review: 4 * 60_000,
  answers: 4 * 60_000,
  rescore: 5 * 60_000,
  prep: 4 * 60_000,
};
/** Extra time before a running task counts as stale, so the worker can record its own timeout first. */
export const DEADLINE_GRACE_MS = 60_000;
export const OUTPUT_CAP = 8000;
export const QUESTIONS_CAP = 8000;
export const CV_VERSION = /^[a-z0-9][a-z0-9-]*$/;

export const tail = (s: string, n = OUTPUT_CAP) => (s.length > n ? '…' + s.slice(-n) : s);

/** Done and failed tasks are deleted this long after they finished (on enqueue). */
export const KEEP_FINISHED_DAYS = 30;
export const DEAD_WORKER_ERROR = 'The worker process exited without recording a result (see data/logs/tasks.log).';

/** Whether a process exists. Signal 0 only checks: ESRCH = no such process, EPERM = it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Fails running tasks whose worker process no longer exists, without waiting for their deadline.
 * Workers always run on this Mac (the dashboard spawns them), so their pid is checked locally.
 * The update re-checks `running`, so a worker that just recorded its result is left alone.
 */
export async function failDeadWorkers(): Promise<number> {
  const { rows } = await pool.query<{ id: number; pid: number }>(`SELECT id, pid FROM tasks WHERE status = 'running' AND pid IS NOT NULL`);
  const dead = rows.filter((r) => !pidAlive(r.pid)).map((r) => r.id);
  if (!dead.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE tasks SET status = 'failed', finished_at = now(), error = $2 WHERE id = ANY($1) AND status = 'running'`,
    [dead, DEAD_WORKER_ERROR],
  );
  return rowCount ?? 0;
}

/**
 * Fails tasks whose worker is gone: a dead worker pid, or past the deadline (see expire_stale_tasks() in the
 * migration). Returns how many.
 */
export async function expireStale(): Promise<number> {
  const dead = await failDeadWorkers();
  return dead + (await pool.query<{ n: number }>('SELECT expire_stale_tasks() n')).rows[0].n;
}

/** Deletes done and failed tasks that finished more than KEEP_FINISHED_DAYS ago. Returns how many. */
export async function pruneFinished(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM tasks WHERE status IN ('done', 'failed') AND coalesce(finished_at, created_at) < now() - make_interval(days => $1)`,
    [KEEP_FINISHED_DAYS],
  );
  return rowCount ?? 0;
}

/**
 * Queues a task, unless the same work is already queued or running: then that task is returned instead
 * (`created: false`). The unique index tasks_one_active makes this safe against concurrent clicks.
 */
export async function enqueue(
  kind: TaskKind,
  jobId: string | null,
  args: Record<string, string> = {},
): Promise<{ task: Task; created: boolean }> {
  await expireStale();
  await pruneFinished();
  for (let attempt = 0; attempt < 3; attempt++) {
    const {
      rows: [task],
    } = await pool.query<Task>(
      `INSERT INTO tasks (kind, job_id, args) VALUES ($1, $2, $3)
       ON CONFLICT (kind, coalesce(job_id, '')) WHERE status IN ('queued', 'running') DO NOTHING RETURNING *`,
      [kind, jobId, JSON.stringify(args)],
    );
    if (task) return { task, created: true };
    const {
      rows: [active],
    } = await pool.query<Task>(
      `SELECT * FROM tasks WHERE kind = $1 AND job_id IS NOT DISTINCT FROM $2 AND status IN ('queued', 'running')`,
      [kind, jobId],
    );
    if (active) return { task: active, created: false };
    // The active task finished between the two queries: try the insert again.
  }
  throw new Error(`Could not enqueue ${kind}`);
}

/** Marks a queued task running for this process. Returns null if it is not queued (already claimed, or expired). */
export async function claim(id: number): Promise<Task | null> {
  const {
    rows: [task],
  } = await pool.query<Task>(
    `UPDATE tasks SET status = 'running', started_at = now(), pid = $2,
       deadline = now() + make_interval(secs => (($3::jsonb ->> kind)::numeric + $4) / 1000)
     WHERE id = $1 AND status = 'queued' RETURNING *`,
    [id, process.pid, JSON.stringify(TASK_TIMEOUT_MS), DEADLINE_GRACE_MS],
  );
  return task ?? null;
}

// finish/fail update the row even if expire_stale_tasks() already failed it: a worker that comes back after
// the Mac slept still reports the real result.
export async function finish(id: number, output: string) {
  await pool.query(`UPDATE tasks SET status = 'done', output = $2, error = NULL, finished_at = now() WHERE id = $1`, [id, tail(output)]);
}

export async function fail(id: number, error: string, output = '') {
  await pool.query(`UPDATE tasks SET status = 'failed', error = $2, output = $3, finished_at = now() WHERE id = $1`, [
    id,
    tail(error, 2000),
    tail(output) || null,
  ]);
}

/**
 * The CLI arguments that run a task, re-validated here because the row is input from the dashboard.
 * `questionsFile` is where task:run wrote args.questions for an answers task.
 */
export function cliArgs(task: Pick<Task, 'kind' | 'job_id' | 'args'>, questionsFile?: string): string[] {
  const job = () => {
    if (!task.job_id) throw new Error(`${task.kind} task without a job`);
    return task.job_id;
  };
  switch (task.kind) {
    case 'fetch':
      return ['fetch'];
    case 'rescore':
      return ['rescore'];
    case 'ai_review':
      return ['ai:score', '--id', job()];
    case 'prepare': {
      const cv = task.args.cv;
      return [
        'prepare',
        job(),
        ...(typeof cv === 'string' && CV_VERSION.test(cv) ? ['--cv', cv] : []),
        ...(task.args.force === 'true' ? ['--force'] : []),
      ]; // "Prepare anyway" on an expired job
    }
    case 'prep':
      return ['prep', job()];
    case 'answers':
      if (!questionsFile) throw new Error('answers task without a questions file');
      return ['answer', job(), '--file', questionsFile];
    default:
      throw new Error(`Unknown task kind ${String(task.kind)}`);
  }
}
