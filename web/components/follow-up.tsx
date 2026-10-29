import { draftFollowUp, markFollowedUp } from '@/app/jobs/[id]/followup-actions';
import type { Job } from '@/lib/db';
import { daysWaiting, FOLLOW_UP_DAYS, type FollowUpInfo, isDue, MAX_FOLLOW_UPS } from '@/lib/followup';
import type { TaskKind } from '@/lib/tasks';
import { CopyButton, SubmitButton } from './client';
import { Busy } from './tasks';
import { fmtDate } from './ui';

/** Job cards: "Follow up · 9 days" on an applied job that is due one. */
export function FollowUpBadge({ job }: { job: FollowUpInfo }) {
  if (!isDue(job)) return null;
  return (
    <span
      title={`No news for ${daysWaiting(job)} days: time to send a short follow-up`}
      className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300"
    >
      Follow up · {daysWaiting(job)} days
    </span>
  );
}

function ActionButton({
  action,
  id,
  children,
  pending,
}: {
  action: (f: FormData) => Promise<void>;
  id: string;
  children: string;
  pending: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <SubmitButton pendingText={pending}>{children}</SubmitButton>
    </form>
  );
}

/**
 * Job page, for applied jobs (and any job with a draft): whether a follow-up is due, the drafted message to copy,
 * and "I sent it" to record it. The bot never sends anything.
 */
export function FollowUp({ job, busy = [] }: { job: Job; busy?: readonly TaskKind[] }) {
  if (job.status !== 'applied' && !job.follow_up_draft) return null;
  const days = daysWaiting(job);
  const due = isDue(job);
  const done = job.follow_ups >= MAX_FOLLOW_UPS;

  return (
    <section className="space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          Follow-up{' '}
          <span className="text-xs font-normal text-zinc-500">
            · {job.follow_ups} of {MAX_FOLLOW_UPS} sent
            {job.followed_up_at && `, last ${fmtDate(job.followed_up_at)}`}
          </span>
        </h2>
        {job.status === 'applied' && (
          <div className="flex gap-2">
            {busy.includes('follow_up') ? (
              <Busy>Drafting follow-up…</Busy>
            ) : (
              <ActionButton action={draftFollowUp} id={job.id} pending="Starting…">
                {job.follow_up_draft ? 'Redraft' : 'Draft follow-up'}
              </ActionButton>
            )}
            {!done && (
              <ActionButton action={markFollowedUp} id={job.id} pending="Saving…">
                I sent a follow-up
              </ActionButton>
            )}
          </div>
        )}
      </div>

      {job.status === 'applied' && (
        <p className={due ? 'text-amber-700 dark:text-amber-400' : 'text-zinc-500'}>
          {done
            ? `You have followed up ${MAX_FOLLOW_UPS} times; no more reminders for this job.`
            : due
              ? `No news for ${days} days: a short follow-up to the recruiter is worth sending.`
              : `Reminder after ${FOLLOW_UP_DAYS} days with no news${days !== null ? ` (${days} so far)` : ''}.`}
        </p>
      )}

      {job.follow_up_draft && (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-zinc-500">
              Draft{job.follow_up_draft_at && ` · ${fmtDate(job.follow_up_draft_at)}`} · review it, then send it yourself
            </span>
            <CopyButton text={job.follow_up_draft} />
          </div>
          <p className="whitespace-pre-line rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">{job.follow_up_draft}</p>
        </div>
      )}
    </section>
  );
}
