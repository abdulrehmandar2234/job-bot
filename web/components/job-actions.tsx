import { aiReview, prepare, setStatus } from '@/app/actions';
import type { Job } from '@/lib/db';
import type { TaskKind } from '@/lib/tasks';
import { SubmitButton } from './client';
import { Busy } from './tasks';
import { SkipButton } from './skip-button';

/** Buttons shown for a job, depending on where it is in the pipeline. `busy`: the job's running background tasks. */
export function JobActions({ job, busy = [] }: { job: Job; busy?: readonly TaskKind[] }) {
  const status = (to: string, label: string, extra = '') => (
    <form action={setStatus}>
      <input type="hidden" name="id" value={job.id} />
      <input type="hidden" name="status" value={to} />
      <SubmitButton className={extra}>{label}</SubmitButton>
    </form>
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <a href={job.url} target="_blank" rel="noreferrer" className="btn btn-primary">Open job ↗</a>

      {busy.includes('prepare') ? (
        <Busy>Preparing CV + letter…</Busy>
      ) : job.cv_version ? (
        <a href={`/api/cv/${job.cv_version}`} target="_blank" className="btn">CV ({job.cv_version})</a>
      ) : (
        <form action={prepare}>
          <input type="hidden" name="id" value={job.id} />
          <SubmitButton pendingText="Starting…">{job.status === 'filtered' ? 'Prepare anyway' : 'Prepare CV + letter'}</SubmitButton>
        </form>
      )}

      {busy.includes('ai_review') ? <Busy>AI reviewing…</Busy> : job.ai_score == null && (
        <form action={aiReview}>
          <input type="hidden" name="id" value={job.id} />
          <SubmitButton pendingText="Starting…">AI review</SubmitButton>
        </form>
      )}

      {(job.status === 'new' || job.status === 'prepared') && <>
        {status('applied', 'Mark applied ✓', 'btn-good')}
        <SkipButton id={job.id} />
      </>}
      {job.status === 'applied' && <>
        {status('interview', 'Got interview')}
        {status('rejected', 'Rejected')}
      </>}
      {job.status === 'interview' && <>
        {status('offer', 'Offer 🎉', 'btn-good')}
        {status('rejected', 'Rejected')}
      </>}
      {job.status === 'skipped' && status('new', 'Move to matching')}
    </div>
  );
}
