import { dismissTask } from '@/app/actions';
import { isActive, TASK_LABEL, type TaskView } from '@/lib/tasks';
import { SubmitButton, TaskWatcher } from './client';

/**
 * Background tasks on a page: a "Working…" line for running ones, each failure with its error and a Dismiss
 * button, the most recently finished task as a one-line notice until dismissed, and the watcher that refreshes
 * the page when a task finishes. `job` limits it to one job's tasks.
 */
export function TaskBar({ tasks, job }: { tasks: TaskView[]; job?: string }) {
  const active = tasks.filter(isActive);
  const failed = tasks.filter((t) => t.status === 'failed');
  const done = tasks.filter((t) => t.status === 'done');
  const finished = done.length ? done.reduce((a, b) => ((b.finished_at ?? 0) > (a.finished_at ?? 0) ? b : a)) : null;
  const label = (t: TaskView) => `${TASK_LABEL[t.kind]}${!job && t.title ? ` (${t.company} — ${t.title})` : ''}`;
  return (
    <>
      <TaskWatcher active={active.map((t) => t.id)} job={job} />
      {active.length > 0 && (
        <p role="status" className="mb-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className="inline-block size-2 animate-pulse rounded-full bg-amber-500" />
          Working… {active.map(label).join(' · ')}
        </p>
      )}
      {finished && (
        <div
          role="status"
          className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/30"
        >
          <p className="font-medium text-emerald-800 dark:text-emerald-300">{label(finished)} finished</p>
          <form action={dismissTask}>
            <input type="hidden" name="task" value={finished.id} />
            <SubmitButton pendingText="…">Dismiss</SubmitButton>
          </form>
        </div>
      )}
      {failed.map((t) => (
        <div
          key={t.id}
          role="alert"
          className="mb-3 flex items-start justify-between gap-3 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm dark:border-rose-900 dark:bg-rose-950/30"
        >
          <div className="min-w-0">
            <p className="font-medium text-rose-800 dark:text-rose-300">{label(t)} failed</p>
            {t.error && (
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-sans text-rose-700 dark:text-rose-400">{t.error}</pre>
            )}
          </div>
          <form action={dismissTask}>
            <input type="hidden" name="task" value={t.id} />
            <SubmitButton pendingText="…">Dismiss</SubmitButton>
          </form>
        </div>
      ))}
    </>
  );
}

/** Shown in place of a button while its task runs. */
export function Busy({ children }: { children: React.ReactNode }) {
  return (
    <span role="status" className="btn cursor-wait opacity-60">
      {children}
    </span>
  );
}
