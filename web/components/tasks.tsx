import { dismissTask } from '@/app/actions';
import { isActive, TASK_LABEL, type TaskView } from '@/lib/tasks';
import { SubmitButton, TaskWatcher } from './client';

/**
 * Background tasks on a page: a "Working…" line for running ones, each failure with its error and a Dismiss
 * button, and the watcher that refreshes the page when a task finishes. `job` limits it to one job's tasks.
 */
export function TaskBar({ tasks, job }: { tasks: TaskView[]; job?: string }) {
  const active = tasks.filter(isActive);
  const failed = tasks.filter((t) => t.status === 'failed');
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
