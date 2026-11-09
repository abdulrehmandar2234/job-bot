import { aiReview, prepare, setStatus } from '@/app/actions';
import type { Job } from '@/lib/db';
import type { TaskKind } from '@/lib/tasks';
import { ActionForm } from './action-form';
import { Busy } from './tasks';
import { SkipButton } from './skip-button';

type Running = readonly TaskKind[];

/** "Open job ↗": the posting on the site it came from. */
export function OpenJobLink({ job }: { job: Pick<Job, 'url'> }) {
  return (
    <a href={job.url} target="_blank" rel="noreferrer" data-shortcut="enter" aria-keyshortcuts="Enter" className="btn btn-primary">
      Open job ↗
    </a>
  );
}

/** "Prepare CV" before a CV exists, "Download CV (version) ↓" after, "Preparing CV…" while it runs. */
export function CvAction({ job, busy = [] }: { job: Job; busy?: Running }) {
  if (busy.includes('prepare')) return <Busy>Preparing CV…</Busy>;
  if (job.cv_version)
    return (
      <a
        href={`/api/cv/${encodeURIComponent(job.cv_version)}?download`}
        data-shortcut="p"
        aria-keyshortcuts="p"
        className="btn"
        title={`CV version: ${job.cv_version}`}
      >
        Download CV ({job.cv_version}) ↓
      </a>
    );
  return (
    <ActionForm
      action={prepare}
      // An expired posting would stop `prepare` at its open check, so "anyway" skips it (--force).
      fields={{ id: job.id, ...(job.status === 'expired' ? { force: 'true' } : {}) }}
      pendingText="Starting…"
      shortcut="p"
      label={job.status === 'filtered' || job.status === 'expired' ? 'Prepare anyway' : 'Prepare CV'}
    />
  );
}

/**
 * AI review (until the job has one, and only while config.json `ai.enabled` is on: `ai`) and the buttons that move a
 * job along the pipeline, including Skip.
 */
export function StatusActions({ job, busy = [], ai = true }: { job: Job; busy?: Running; ai?: boolean }) {
  const status = (to: string, label: string, extra = '', shortcut?: string) => (
    <ActionForm action={setStatus} fields={{ id: job.id, status: to }} buttonClass={extra} shortcut={shortcut} label={label} />
  );

  return (
    <>
      {busy.includes('ai_review') ? (
        <Busy>AI reviewing…</Busy>
      ) : (
        ai && job.ai_score == null && <ActionForm action={aiReview} fields={{ id: job.id }} pendingText="Starting…" label="AI review" />
      )}

      {(job.status === 'new' || job.status === 'prepared') && (
        <>
          {status('applied', 'Mark applied ✓', 'btn-good', 'a')}
          <SkipButton id={job.id} />
        </>
      )}
      {job.status === 'applied' && (
        <>
          {status('interview', 'Got interview')}
          {status('rejected', 'Rejected')}
        </>
      )}
      {job.status === 'interview' && (
        <>
          {status('offer', 'Offer 🎉', 'btn-good')}
          {status('rejected', 'Rejected')}
        </>
      )}
      {(job.status === 'skipped' || job.status === 'expired') && status('new', 'Move to matching')}
    </>
  );
}

/**
 * Buttons shown for a job, depending on where it is in the pipeline. `busy`: the job's running background tasks.
 * The job page places the three parts apart (summary card, CV block, actions); the list cards show them in one row.
 */
export function JobActions({ job, busy = [], ai = true }: { job: Job; busy?: Running; ai?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <OpenJobLink job={job} />
      <CvAction job={job} busy={busy} />
      <StatusActions job={job} busy={busy} ai={ai} />
    </div>
  );
}
