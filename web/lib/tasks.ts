import * as queue from '../../src/task-queue.ts';
import { KEEP_FINISHED_DAYS, type Task, type TaskKind } from '../../src/types.ts';
import { spawnBot } from './bot';
import { pool } from './db';

export type { Task, TaskKind };

// Long bot commands run as background tasks (table `tasks`, see job-bot/src/tasks.ts): the dashboard queues one,
// spawns a detached `bot task:run <id>` and returns at once. Queueing and the dead-worker / stale checks are the
// bot's own (src/task-queue.ts), run on the dashboard's pool; this file adds the labels, the poll throttle and the
// dashboard's views.

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

/** CV_CHANGES: kinds that change a job's CV version (as CV_TASKS in components/cv-panel.tsx), one at a time per job;
 * enqueueTask throws CvBusyError for a second one. */
export { CV_CHANGES, CvBusyError, DEAD_WORKER_ERROR, pidAlive } from '../../src/task-queue.ts';

/** Done and failed tasks are deleted this long after they finished (on enqueue): the bot's rule (src/types.ts). */
export { KEEP_FINISHED_DAYS };

/** Fails running tasks whose worker process is gone, without waiting for the deadline. Returns how many. */
export const failDeadWorkers = () => queue.failDeadWorkers(pool);

/** How often openTasks runs the stale check at most: every page render and every TaskWatcher poll (each ~3s, per
 * tab) calls it, and a task going stale a few seconds later is fine. Enqueueing always runs it (src/task-queue.ts). */
export const EXPIRE_EVERY_MS = 10_000;
// Timed with performance.now(), not Date.now(): pages that list tasks are prerendered, and Next refuses a wall-clock
// read there. It counts from process start, so "never ran" is -Infinity, not 0.
let lastExpire = Number.NEGATIVE_INFINITY;

/** For tests: forget the last stale check, so the next openTasks runs one. */
export function resetExpireThrottle() {
  lastExpire = Number.NEGATIVE_INFINITY;
}

/** Fails tasks whose worker died (a dead pid, or past the deadline), at most once per EXPIRE_EVERY_MS. */
async function expireStale() {
  const now = performance.now();
  if (now - lastExpire < EXPIRE_EVERY_MS) return;
  lastExpire = now;
  await queue.expireStale(pool);
}

/** Deletes done and failed tasks that finished more than KEEP_FINISHED_DAYS ago. Returns how many. */
export const pruneFinished = () => queue.pruneFinished(pool);

/**
 * Queues a task (src/task-queue.ts enqueue: one task per kind and job, one CV change per job, CvBusyError otherwise)
 * and starts its worker. Work already queued or running is returned instead, and nothing is started.
 */
export async function enqueueTask(
  kind: TaskKind,
  jobId: string | null,
  args: Record<string, string> = {},
): Promise<{ task: Task; created: boolean }> {
  lastExpire = performance.now(); // enqueue always runs the stale check: the next poll need not
  const queued = await queue.enqueue(pool, kind, jobId, args, TASK_LABEL[kind].toLowerCase());
  if (queued.created) spawnBot(['task:run', String(queued.task.id)]);
  return queued;
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
