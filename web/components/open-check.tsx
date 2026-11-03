import { checkStillOpen } from '@/app/jobs/[id]/open-actions';
import type { Job } from '@/lib/db';
import { ActionForm } from './action-form';
import { ago, fmtDate } from './ui';

type OpenInfo = Pick<Job, 'status'> & Partial<Pick<Job, 'closed_at'>>;

/** "Expired" when the bot found the posting closed; "Posting closed" on a job you applied to (its status stays). */
export function ExpiredBadge({ job }: { job: OpenInfo }) {
  if (job.status !== 'expired' && !job.closed_at) return null;
  return (
    <span
      title={job.closed_at ? `Posting found closed on ${fmtDate(job.closed_at)}` : 'Posting closed'}
      className="rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
    >
      {job.status === 'expired' ? 'Expired' : 'Posting closed'}
    </span>
  );
}

/** Job page: when the posting was last checked, and a button to check it now. */
export function OpenCheck({ job }: { job: Pick<Job, 'id'> & Partial<Pick<Job, 'checked_open_at'>> }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
      <ActionForm action={checkStillOpen} fields={{ id: job.id }} pendingText="Checking…" label="Check if still open" />
      <span>{job.checked_open_at ? `Posting last checked ${ago(job.checked_open_at)}` : 'Posting not checked yet'}</span>
    </div>
  );
}
