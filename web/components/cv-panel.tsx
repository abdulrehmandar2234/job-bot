import { improveCv, reviewCv } from '@/app/actions';
import { defaultTemplate, TEMPLATES, templateName, versionInfo } from '@/lib/cv-templates';
import type { Job } from '@/lib/db';
import { CV_CHANGES, type TaskKind } from '@/lib/tasks';
import { ApplyTemplateForm } from './apply-template';
import { SubmitButton } from './client';
import { CvFeedback } from './cv-feedback';
import { AiOffNote } from './ai-off';
import { Busy } from './tasks';

/** Tasks that change the job's CV version; while one runs, the others are hidden (and enqueueTask refuses them). */
export const CV_TASKS: readonly TaskKind[] = CV_CHANGES;

/**
 * The job's CV on the job page: its version and template, a template select with Apply template (`bot cv:template`,
 * a new version, never overwriting one that may have been sent), previews of each template, Download CV, feedback
 * for the AI (`bot cv:feedback`) and "Suggest improvements" (`bot cv:review`). The last two need the AI: with it off
 * (`ai`), a note linking to Settings replaces them.
 */
export function CvPanel({ job, busy = [], ai = true }: { job: Job; busy?: readonly TaskKind[]; ai?: boolean }) {
  const fallback = defaultTemplate();
  const chosen = job.cv_template && TEMPLATES.some((t) => t.id === job.cv_template) ? (job.cv_template as typeof fallback) : fallback;
  const info = job.cv_version ? versionInfo(job.cv_version) : null;
  const current = info?.template ?? null;
  const changing = CV_TASKS.find((k) => busy.includes(k));
  return (
    <section aria-labelledby="cv-panel" className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cv-panel" className="font-medium">
          CV for this job{' '}
          <span className="text-xs font-normal text-zinc-500">
            {job.cv_version && current ? `· ${job.cv_version} · ${templateName(current)} template` : '· not prepared yet'}
          </span>
        </h2>
        {job.cv_version && !changing && (
          <a href={`/api/cv/${encodeURIComponent(job.cv_version)}?download`} className="btn">
            Download CV ↓
          </a>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <ApplyTemplateForm id={job.id} chosen={chosen} fallback={fallback} changing={changing ?? null} />
        <span className="text-xs text-zinc-500">
          Preview:{' '}
          {TEMPLATES.map((t, i) => (
            <span key={t.id}>
              {i > 0 && ' · '}
              <a href={`/api/cv/preview/${t.id}`} target="_blank" rel="noreferrer" className="underline" title={t.description}>
                {t.name}
              </a>
            </span>
          ))}
        </span>
      </div>
      <p className="text-xs text-zinc-500">
        {job.cv_version
          ? 'Applying a template builds a new CV version; the CV you may already have sent stays as it is.'
          : 'The template is used when the CV is prepared.'}
      </p>

      {changing === 'cv_feedback' && <Busy>Improving CV with your feedback…</Busy>}
      {/* Prepare and "Use in my CV" show their own "…" status elsewhere on the page. */}
      {changing && changing !== 'cv_feedback' && changing !== 'cv_template' && (
        <p className="text-sm text-zinc-500">The CV is being built; these options come back when it is done.</p>
      )}
      {info && info.feedbackNote.length > 0 && <FeedbackNote lines={info.feedbackNote} />}
      {ai ? (
        <>
          <CvFeedback id={job.id} review={job.cv_review ?? null} busy={!!changing || busy.includes('cv_review')} improve={improveCv} />
          {busy.includes('cv_review') ? (
            <Busy>Reviewing CV…</Busy>
          ) : (
            <form action={reviewCv} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={job.id} />
              <SubmitButton pendingText="Starting…">{job.cv_review ? 'Suggest again' : 'Suggest improvements'}</SubmitButton>
              <span className="text-xs text-zinc-500">
                The AI reviews this CV against the job: what is weak or missing, and what to put first.
              </span>
            </form>
          )}
        </>
      ) : (
        <AiOffNote what="CV feedback (improving the CV and suggestions)" />
      )}
    </section>
  );
}

/** What the AI and the master-CV check left out when this CV was made with feedback (its meta.json). */
function FeedbackNote({ lines }: { lines: string[] }) {
  return (
    <div role="note" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
      <p className="font-medium">Left out of this CV when it was revised (not on your master CV):</p>
      <ul className="list-disc pl-5">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
    </div>
  );
}
