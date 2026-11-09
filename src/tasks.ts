import { pool } from './db.ts';
import * as queue from './task-queue.ts';
import { CV_VERSION, FEEDBACK_CAP, KEEP_FINISHED_DAYS, type Task, type TaskKind } from './types.ts';
import { isTemplate } from './cv/templates/index.ts';
import { parseSkills } from './cv/confirm-skills.ts';

// The background task queue (table `tasks`, src/migrations/002_tasks.sql).
// The dashboard enqueues (web/lib/tasks.ts, with the shared rules in src/task-queue.ts) and spawns a detached
// `task:run <id>` (src/commands/task.ts), which claims the row, runs the normal CLI command and stores the result.

/**
 * A kind that makes an AI call must outlive the overall per-call AI budget (AI_BUDGET in src/ai-providers.ts,
 * 5 minutes) with a margin, so the worker records the real provider error instead of SIGKILLing the child and
 * reporting a generic "Timed out" (tests/tasks.test.ts ties the two values together).
 */
const AI_TASK_MS = 6 * 60_000;

/** How long each kind may run before the worker kills it. */
export const TASK_TIMEOUT_MS: Record<TaskKind, number> = {
  fetch: 20 * 60_000,
  prepare: 4 * 60_000,
  ai_review: AI_TASK_MS,
  answers: AI_TASK_MS,
  rescore: 5 * 60_000,
  prep: AI_TASK_MS,
  follow_up: AI_TASK_MS,
  letter: AI_TASK_MS,
  summary: AI_TASK_MS,
  tailored_cv: 4 * 60_000,
  cv_template: 4 * 60_000,
  cv_feedback: AI_TASK_MS,
  cv_review: AI_TASK_MS,
};
/** Extra time before a running task counts as stale, so the worker can record its own timeout first. */
export const DEADLINE_GRACE_MS = 60_000;
export { FEEDBACK_CAP, KEEP_FINISHED_DAYS };
export const OUTPUT_CAP = 8000;
export const QUESTIONS_CAP = 8000;

export const tail = (s: string, n = OUTPUT_CAP) => (s.length > n ? '…' + s.slice(-n) : s);

// Queueing and the dead-worker / stale checks are shared with the dashboard (src/task-queue.ts); here they run on the
// bot's pool.
export { CV_CHANGES, CvBusyError, DEAD_WORKER_ERROR, pidAlive } from './task-queue.ts';
export const failDeadWorkers = () => queue.failDeadWorkers(pool);
export const expireStale = () => queue.expireStale(pool);
export const pruneFinished = () => queue.pruneFinished(pool);
export const enqueue = (kind: TaskKind, jobId: string | null, args: Record<string, string> = {}) => queue.enqueue(pool, kind, jobId, args);

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
 * `--feedback=<text>` for a letter, summary or CV task with feedback, else nothing. Throws when the feedback is not a
 * string of at most FEEDBACK_CAP characters. One `--name=value` argument, so text starting with "--" stays the value.
 */
export function feedbackArgs(args: Record<string, unknown>): string[] {
  const feedback = args.feedback;
  if (feedback === undefined) return [];
  if (typeof feedback !== 'string') throw new Error('Feedback must be text');
  if (feedback.length > FEEDBACK_CAP) throw new Error(`Feedback is too long (at most ${FEEDBACK_CAP} characters)`);
  const text = feedback.trim();
  return text ? [`--feedback=${text}`] : [];
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
    case 'follow_up':
      return ['follow-up', job()];
    case 'letter':
      return ['letter', job(), ...feedbackArgs(task.args)];
    case 'summary':
      return ['summary', job(), ...feedbackArgs(task.args)];
    case 'tailored_cv':
      return ['cv:tailor', job()];
    case 'cv_template': {
      const template = task.args.template;
      if (!isTemplate(template)) throw new Error(`Unknown CV template ${JSON.stringify(template)}`);
      return ['cv:template', job(), template];
    }
    case 'cv_feedback': {
      const feedback = feedbackArgs(task.args);
      const skills = typeof task.args.skills === 'string' ? parseSkills(task.args.skills) : [];
      if ('error' in skills) throw new Error(skills.error);
      if (!feedback.length && !skills.length) throw new Error('Write what should change in the CV first');
      return ['cv:feedback', job(), ...feedback, ...(skills.length ? [`--add-skills=${skills.join(',')}`] : [])];
    }
    case 'cv_review':
      return ['cv:review', job()];
    case 'answers':
      if (!questionsFile) throw new Error('answers task without a questions file');
      return ['answer', job(), '--file', questionsFile];
    default:
      throw new Error(`Unknown task kind ${String(task.kind)}`);
  }
}
