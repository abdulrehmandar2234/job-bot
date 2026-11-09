import { KEEP_FINISHED_DAYS, type Task, type TaskKind } from './types.ts';

// The background task queue's rules (table `tasks`, src/migrations/002_tasks.sql): queueing, with its one-at-a-time
// checks, and failing tasks whose worker died. Every function takes the database, so the bot (src/tasks.ts, on its
// own pool) and the dashboard (web/lib/tasks.ts, on its pool) run the same SQL. Nothing happens on import.

/** What the queue needs from a pg Pool (or client). */
export type Db = {
  query<R extends Record<string, any> = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
};

/** Kinds that change a job's CV version: one at a time per job, whatever the kind. */
export const CV_CHANGES: readonly TaskKind[] = ['prepare', 'tailored_cv', 'cv_template', 'cv_feedback'];

/** Thrown by enqueue when another task is already changing the job's CV. The message is shown to the user. */
export class CvBusyError extends Error {
  constructor() {
    super('The CV is being changed right now. Try again when it is done.');
    this.name = 'CvBusyError';
  }
}

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
 * Fails running tasks whose worker process no longer exists, without waiting for their deadline. Workers always run
 * on this computer (the dashboard spawns them), so their pid is checked locally. The update re-checks `running`, so a
 * worker that just recorded its result is left alone. Returns how many.
 */
export async function failDeadWorkers(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: number; pid: number }>(`SELECT id, pid FROM tasks WHERE status = 'running' AND pid IS NOT NULL`);
  const dead = rows.filter((r) => !pidAlive(r.pid)).map((r) => r.id);
  if (!dead.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE tasks SET status = 'failed', finished_at = now(), error = $2 WHERE id = ANY($1) AND status = 'running'`,
    [dead, DEAD_WORKER_ERROR],
  );
  return rowCount ?? 0;
}

/**
 * Fails tasks whose worker is gone: a dead worker pid, or past the deadline (expire_stale_tasks() in the migration).
 * Returns how many.
 */
export async function expireStale(db: Db): Promise<number> {
  const dead = await failDeadWorkers(db);
  return dead + (await db.query<{ n: number }>('SELECT expire_stale_tasks() n')).rows[0].n;
}

/** Deletes done and failed tasks that finished more than KEEP_FINISHED_DAYS ago. Returns how many. */
export async function pruneFinished(db: Db): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM tasks WHERE status IN ('done', 'failed') AND coalesce(finished_at, created_at) < now() - make_interval(days => $1)`,
    [KEEP_FINISHED_DAYS],
  );
  return rowCount ?? 0;
}

/**
 * Queues a task (stale tasks expire and old ones are pruned first). If the same work is already queued or running
 * (one fetch at a time, one task per kind and job), returns that task instead (`created: false`); the unique index
 * tasks_one_active makes this safe against concurrent clicks. A CV-changing kind (CV_CHANGES) is refused with
 * CvBusyError while another CV-changing kind is active for the job: the insert itself checks (INSERT … WHERE NOT
 * EXISTS), so two different kinds queued at the same time cannot both pass. Starting the worker is the caller's job.
 * `what` names the task in the error when every attempt raced with a finishing task ("re-scoring jobs").
 */
export async function enqueue(
  db: Db,
  kind: TaskKind,
  jobId: string | null,
  args: Record<string, string> = {},
  what = `the ${kind} task`,
): Promise<{ task: Task; created: boolean }> {
  await expireStale(db);
  await pruneFinished(db);
  const cvChange = jobId !== null && CV_CHANGES.includes(kind);
  for (let attempt = 0; attempt < 3; attempt++) {
    const {
      rows: [task],
    } = await db.query<Task>(
      cvChange
        ? `INSERT INTO tasks (kind, job_id, args)
           SELECT $1::text, $2::text, $3::jsonb WHERE NOT EXISTS (
             SELECT 1 FROM tasks WHERE job_id = $2 AND kind <> $1 AND kind = ANY($4::text[]) AND status IN ('queued', 'running'))
           ON CONFLICT (kind, coalesce(job_id, '')) WHERE status IN ('queued', 'running') DO NOTHING RETURNING *`
        : `INSERT INTO tasks (kind, job_id, args) VALUES ($1, $2, $3)
           ON CONFLICT (kind, coalesce(job_id, '')) WHERE status IN ('queued', 'running') DO NOTHING RETURNING *`,
      cvChange ? [kind, jobId, JSON.stringify(args), [...CV_CHANGES]] : [kind, jobId, JSON.stringify(args)],
    );
    if (task) return { task, created: true };
    const {
      rows: [active],
    } = await db.query<Task>(`SELECT * FROM tasks WHERE kind = $1 AND job_id IS NOT DISTINCT FROM $2 AND status IN ('queued', 'running')`, [
      kind,
      jobId,
    ]);
    if (active) return { task: active, created: false };
    if (cvChange) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM tasks WHERE job_id = $1 AND kind = ANY($2::text[]) AND status IN ('queued', 'running')`,
        [jobId, [...CV_CHANGES]],
      );
      if (rowCount) throw new CvBusyError();
    }
    // The active task finished between the queries: try the insert again.
  }
  throw new Error(`Could not start ${what}`);
}
