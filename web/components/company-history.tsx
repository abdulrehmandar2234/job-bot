import Link from 'next/link';
import { blockCompany } from '@/app/settings/actions';
import { ActionForm } from '@/components/action-form';
import { fmtDate, STATUS_LABEL } from '@/components/ui';
import { ConfirmFirst } from '@/components/written-text';
import type { CompanyHistory as History } from '@/lib/db';
import { SKIP_LABEL } from '@/lib/skips';
import type { SkipReason } from '../../src/types';

/**
 * The company block on a job page: the other jobs at this company you acted on (and their outcome), how many more
 * are waiting, and "Never show this company", which adds it to config.json blockedCompanies.
 */
export function CompanyHistory({
  job,
  history,
  hiddenAs,
}: {
  job: { id: string; company: string };
  history: History;
  /** The blockedCompanies entry that already hides this company, if any. */
  hiddenAs?: string;
}) {
  const { jobs, open } = history;
  return (
    <section aria-labelledby="company-heading" className="space-y-2">
      <h2 id="company-heading" className="font-medium">
        Your history with {job.company}
      </h2>
      {jobs.length === 0 ? (
        <p className="text-sm text-zinc-500">No other job at {job.company} that you prepared, applied to or skipped.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link href={`/jobs/${encodeURIComponent(j.id)}`} className="hover:underline">
                {j.title}
              </Link>{' '}
              <span className="text-zinc-500">
                · {STATUS_LABEL[j.status]}
                {j.reason && ` (${SKIP_LABEL[j.reason as SkipReason] ?? j.reason})`}
                {j.applied_at ? ` · applied ${fmtDate(j.applied_at)}` : ` · seen ${fmtDate(j.first_seen_at)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open > 0 && (
        <p className="text-sm text-zinc-500">
          {open} more job{open === 1 ? '' : 's'} at {job.company} waiting in Matching.
        </p>
      )}
      {hiddenAs ? (
        <p className="text-sm text-zinc-500">
          Hidden: new jobs from this company are filtered out (Settings, Companies to hide: “{hiddenAs}”).
        </p>
      ) : (
        <ConfirmFirst
          message={`Hide every job from ${job.company} that is still waiting, and its new ones? You can undo it under Settings.`}
        >
          <ActionForm action={blockCompany} fields={{ id: job.id }} pendingText="Hiding…" label="Never show this company" />
        </ConfirmFirst>
      )}
    </section>
  );
}
