import { aiReview, prepare, setStatus } from '@/app/actions';
import type { Job } from '@/lib/db';
import type { TaskKind } from '@/lib/tasks';
import { SubmitButton } from './client';
import { Busy } from './tasks';
import { SkipButton } from './skip-button';

type Running = readonly TaskKind[];

/** "Open job ↗": the posting on the site it came from. */
export function OpenJobLink({ job }: { job: Pick<Job, 'url'> }) {
  return (
    <a href={job.url} target="_blank" rel="noreferrer" className="btn btn-primary">
      Open job ↗
    </a>
  );
}

/** "Prepare CV" before a CV exists, "Download CV (version) ↓" after, "Preparing CV…" while it runs. */
export function CvAction({ job, busy = [] }: { job: Job; busy?: Running }) {
  if (busy.includes('prepare')) return <Busy>Preparing CV…</Busy>;
  if (job.cv_version)
    return (
      <a href={`/api/cv/${encodeURIComponent(job.cv_version)}?download`} className="btn" title={`CV version: ${job.cv_version}`}>
        Download CV ({job.cv_version}) ↓
      </a>
    );
  return (
    <form action={prepare}>
      <input type="hidden" name="id" value={job.id} />
      {/* An expired posting would stop `prepare` at its open check, so "anyway" skips it (--force). */}
      {job.status === 'expired' && <input type="hidden" name="force" value="true" />}
      <SubmitButton pendingText="Starting…">
        {job.status === 'filtered' || job.status === 'expired' ? 'Prepare anyway' : 'Prepare CV'}
      </SubmitButton>
    </form>
  );
}

/** AI review (until the job has one) and the buttons that move a job along the pipeline, including Skip. */
export function StatusActions({ job, busy = [] }: { job: Job; busy?: Running }) {
  const status = (to: string, label: string, extra = '') => (
    <form action={setStatus}>
      <input type="hidden" name="id" value={job.id} />
      <input type="hidden" name="status" value={to} />
      <SubmitButton className={extra}>{label}</SubmitButton>
    </form>
  );

  return (
    <>
      {busy.includes('ai_review') ? (
        <Busy>AI reviewing…</Busy>
      ) : (
        job.ai_score == null && (
          <form action={aiReview}>
            <input type="hidden" name="id" value={job.id} />
            <SubmitButton pendingText="Starting…">AI review</SubmitButton>
          </form>
        )
      )}

      {(job.status === 'new' || job.status === 'prepared') && (
        <>
          {status('applied', 'Mark applied ✓', 'btn-good')}
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
export function JobActions({ job, busy = [] }: { job: Job; busy?: Running }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <OpenJobLink job={job} />
      <CvAction job={job} busy={busy} />
      <StatusActions job={job} busy={busy} />
    </div>
  );
}
