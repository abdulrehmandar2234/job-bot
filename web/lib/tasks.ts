import { KEEP_FINISHED_DAYS, type Task, type TaskKind } from '../../src/types.ts';
import { spawnBot } from './bot';
import { pool } from './db';

export type { Task, TaskKind };

// Long bot commands run as background tasks (table `tasks`, see job-bot/src/tasks.ts): the dashboard queues one,
// spawns a detached `bot task:run <id>` and returns at once. The enqueue SQL matches enqueue() in src/tasks.ts.

/** What the dashboard shows of a task: active ones, failures until dismissed, and just-finished ones as a notice. */
export type TaskView = Pick<Task, 'id' | 'kind' | 'job_id' | 'status' | 'error' | 'created_at' | 'started_at' | 'finished_at'> & {
  company: string | null;
  title: string | null;
};

export const TASK_LABEL: Record<TaskKind, string> = {
  fetch: 'Fetching new jobs',
  prepare: 'Preparing CV',
  ai_review: 'AI reviewing',
  answers: 'Drafting answers',
  rescore: 'Re-scoring jobs',
  prep: 'Preparing interview notes',
  follow_up: 'Drafting follow-up',
  letter: 'Writing cover letter',
  summary: 'Writing CV summary',
  tailored_cv: 'Building CV with summary',
  cv_template: 'Applying CV template',
  cv_feedback: 'Improving CV with feedback',
  cv_review: 'Reviewing CV',
};

export const isActive = (t: Pick<Task, 'status'>) => t.status === 'queued' || t.status === 'running';

/** Tasks that change a job's CV version (as CV_TASKS in components/cv-panel.tsx): one at a time per job. */
export const CV_CHANGES: readonly TaskKind[] = ['prepare', 'tailored_cv', 'cv_template', 'cv_feedback'];

/** Thrown by enqueueTask when another task is already changing the job's CV. The message is shown to the user. */
export class CvBusyError extends Error {
  constructor() {
    super('The CV is being changed right now. Try again when it is done.');
    this.name = 'CvBusyError';
  }
}

/** Done and failed tasks are deleted this long after they finished (on enqueue): the bot's rule (src/types.ts). */
export { KEEP_FINISHED_DAYS };
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
 * Fails running tasks whose worker process is gone, without waiting for the deadline. Workers are spawned by this
 * dashboard on this Mac, so their pid is checked locally. The update re-checks `running`, so a worker that just
 * recorded its result is left alone.
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

/** How often openTasks runs the stale check at most: every page render and every TaskWatcher poll (each ~3s, per
 * tab) calls it, and a task going stale a few seconds later is fine. Enqueueing always runs it (`force`). */
export const EXPIRE_EVERY_MS = 10_000;
// Timed with performance.now(), not Date.now(): pages that list tasks are prerendered, and Next refuses a wall-clock
// read there. It counts from process start, so "never ran" is -Infinity, not 0.
let lastExpire = Number.NEGATIVE_INFINITY;

/** For tests: forget the last stale check, so the next openTasks runs one. */
export function resetExpireThrottle() {
  lastExpire = Number.NEGATIVE_INFINITY;
}

/** Fails tasks whose worker died: a dead pid, or past the deadline (expire_stale_tasks() in the migration). */
async function expireStale(force = false) {
  const now = performance.now();
  if (!force && now - lastExpire < EXPIRE_EVERY_MS) return;
  lastExpire = now;
  await failDeadWorkers();
  await pool.query('SELECT expire_stale_tasks()');
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
 * Queues a task and starts its worker. If the same work is already queued or running (one fetch at a time,
 * one task per kind and job), returns that task instead and starts nothing. A CV-changing kind (CV_CHANGES)
 * is refused with CvBusyError while another CV-changing kind runs for the job: the insert itself checks
 * (INSERT … WHERE NOT EXISTS), so two different kinds enqueued at the same time cannot both pass.
 */
export async function enqueueTask(
  kind: TaskKind,
  jobId: string | null,
  args: Record<string, string> = {},
): Promise<{ task: Task; created: boolean }> {
  await expireStale(true);
  await pruneFinished();
  const cvChange = jobId !== null && CV_CHANGES.includes(kind);
  for (let attempt = 0; attempt < 3; attempt++) {
    const {
      rows: [task],
    } = await pool.query<Task>(
      cvChange
        ? `INSERT INTO tasks (kind, job_id, args)
           SELECT $1::text, $2::text, $3::jsonb WHERE NOT EXISTS (
             SELECT 1 FROM tasks WHERE job_id = $2 AND kind <> $1 AND kind = ANY($4::text[]) AND status IN ('queued', 'running'))
           ON CONFLICT (kind, coalesce(job_id, '')) WHERE status IN ('queued', 'running') DO NOTHING RETURNING *`
        : `INSERT INTO tasks (kind, job_id, args) VALUES ($1, $2, $3)
           ON CONFLICT (kind, coalesce(job_id, '')) WHERE status IN ('queued', 'running') DO NOTHING RETURNING *`,
      cvChange ? [kind, jobId, JSON.stringify(args), [...CV_CHANGES]] : [kind, jobId, JSON.stringify(args)],
    );
    if (task) {
      spawnBot(['task:run', String(task.id)]);
      return { task, created: true };
    }
    const {
      rows: [active],
    } = await pool.query<Task>(
      `SELECT * FROM tasks WHERE kind = $1 AND job_id IS NOT DISTINCT FROM $2 AND status IN ('queued', 'running')`,
      [kind, jobId],
    );
    if (active) return { task: active, created: false };
    if (cvChange) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM tasks WHERE job_id = $1 AND kind = ANY($2::text[]) AND status IN ('queued', 'running')`,
        [jobId, [...CV_CHANGES]],
      );
      if (rowCount) throw new CvBusyError();
    }
  }
  throw new Error(`Could not start ${TASK_LABEL[kind].toLowerCase()}`);
}

/** A done task is offered as a "finished" notice this long (until dismissed); older ones stay hidden. */
export const FINISHED_NOTICE_MS = 60 * 60_000;

/**
 * Active tasks, undismissed failures and recently finished, undismissed tasks (the "finished" notice), oldest
 * first; only one job's when `jobId` is given.
 */
export async function openTasks(jobId?: string): Promise<TaskView[]> {
  await expireStale();
  const { rows } = await pool.query<TaskView>(
    `SELECT t.id, t.kind, t.job_id, t.status, t.error, t.created_at, t.started_at, t.finished_at, j.company, j.title
     FROM tasks t LEFT JOIN jobs j ON j.id = t.job_id
     WHERE (t.status IN ('queued', 'running') OR (t.status = 'failed' AND NOT t.dismissed)
        OR (t.status = 'done' AND NOT t.dismissed AND t.finished_at > now() - make_interval(secs => $2)))
       AND ($1::text IS NULL OR t.job_id = $1)
     ORDER BY t.created_at, t.id`,
    [jobId ?? null, FINISHED_NOTICE_MS / 1000],
  );
  return rows;
}

/** Hides a failed task's error or a finished task's notice from the dashboard. Returns false if there is no such task. */
export async function dismissTask(id: number) {
  const { rowCount } = await pool.query(`UPDATE tasks SET dismissed = true WHERE id = $1 AND status IN ('done', 'failed')`, [id]);
  return rowCount === 1;
}
