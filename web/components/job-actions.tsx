import { aiReview, prepare, setStatus } from '@/app/actions';
import type { Job } from '@/lib/db';
import { SubmitButton } from './client';

/** Buttons shown for a job, depending on where it is in the pipeline. */
export function JobActions({ job }: { job: Job }) {
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

      {job.cv_version ? (
        <a href={`/api/cv/${job.cv_version}`} target="_blank" className="btn">CV ({job.cv_version})</a>
      ) : (
        <form action={prepare}>
          <input type="hidden" name="id" value={job.id} />
          <SubmitButton pendingText="AI writing letter… (~20s)">{job.status === 'filtered' ? 'Prepare anyway' : 'Prepare CV + letter'}</SubmitButton>
        </form>
      )}

      {job.ai_score == null && (
        <form action={aiReview}>
          <input type="hidden" name="id" value={job.id} />
          <SubmitButton pendingText="AI reviewing… (~15s)">AI review</SubmitButton>
        </form>
      )}

      {(job.status === 'new' || job.status === 'prepared') && <>
        {status('applied', 'Mark applied ✓', 'btn-good')}
        {status('skipped', 'Skip')}
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
