import type { Task, TaskKind } from '../../src/types';
import { spawnBot } from './bot';
import { pool } from './db';

export type { Task, TaskKind };

// Long bot commands run as background tasks (table `tasks`, see job-bot/src/tasks.ts): the dashboard queues one,
// spawns a detached `bot task:run <id>` and returns at once. The enqueue SQL matches enqueue() in src/tasks.ts.

/** What the dashboard shows of a task: active ones, and failures until dismissed. */
export type TaskView = Pick<Task, 'id' | 'kind' | 'job_id' | 'status' | 'error' | 'created_at' | 'started_at'>
  & { company: string | null; title: string | null };

export const TASK_LABEL: Record<TaskKind, string> = {
  fetch: 'Fetching new jobs',
  prepare: 'Preparing CV + letter',
  ai_review: 'AI reviewing',
  answers: 'Drafting answers',
  rescore: 'Re-scoring jobs',
};

export const isActive = (t: Pick<Task, 'status'>) => t.status === 'queued' || t.status === 'running';

/** Fails tasks whose worker died (process killed, Mac restarted); see expire_stale_tasks() in the migration. */
const expireStale = () => pool.query('SELECT expire_stale_tasks()');

/**
 * Queues a task and starts its worker. If the same work is already queued or running (one fetch at a time,
 * one task per kind and job), returns that task instead and starts nothing.
 */
export async function enqueueTask(kind: TaskKind, jobId: string | null, args: Record<string, string> = {}):
  Promise<{ task: Task; created: boolean }> {
  await expireStale();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { rows: [task] } = await pool.query<Task>(
      `INSERT INTO tasks (kind, job_id, args) VALUES ($1, $2, $3)
       ON CONFLICT (kind, coalesce(job_id, '')) WHERE status IN ('queued', 'running') DO NOTHING RETURNING *`,
      [kind, jobId, JSON.stringify(args)]);
    if (task) {
      spawnBot(['task:run', String(task.id)]);
      return { task, created: true };
    }
    const { rows: [active] } = await pool.query<Task>(
      `SELECT * FROM tasks WHERE kind = $1 AND job_id IS NOT DISTINCT FROM $2 AND status IN ('queued', 'running')`, [kind, jobId]);
    if (active) return { task: active, created: false };
  }
  throw new Error(`Could not start ${TASK_LABEL[kind].toLowerCase()}`);
}

/** Active tasks and undismissed failures, oldest first; only one job's when `jobId` is given. */
export async function openTasks(jobId?: string): Promise<TaskView[]> {
  await expireStale();
  const { rows } = await pool.query<TaskView>(
    `SELECT t.id, t.kind, t.job_id, t.status, t.error, t.created_at, t.started_at, j.company, j.title
     FROM tasks t LEFT JOIN jobs j ON j.id = t.job_id
     WHERE (t.status IN ('queued', 'running') OR (t.status = 'failed' AND NOT t.dismissed))
       AND ($1::text IS NULL OR t.job_id = $1)
     ORDER BY t.created_at, t.id`, [jobId ?? null]);
  return rows;
}

/** Hides a failed task from the dashboard. Returns false if there is no such failure. */
export async function dismissTask(id: number) {
  const { rowCount } = await pool.query(`UPDATE tasks SET dismissed = true WHERE id = $1 AND status = 'failed'`, [id]);
  return rowCount === 1;
}
