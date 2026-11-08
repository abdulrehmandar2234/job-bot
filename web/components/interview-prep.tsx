import { prepareInterview } from '@/app/jobs/[id]/interview-actions';
import type { InterviewPrep as Prep, Job } from '@/lib/db';
import type { TaskKind } from '@/lib/tasks';
import { ActionForm } from './action-form';
import { CopyButton } from './client';
import { AiOffNote } from './ai-off';
import { Busy } from './tasks';
import { fmtDate } from './ui';

const star = (b: Prep['behavioural'][number]) => `Situation: ${b.situation}\nTask: ${b.task}\nAction: ${b.action}\nResult: ${b.result}`;

/** The whole prep as plain text, for "Copy all". */
export function prepText(p: Prep): string {
  return [
    'TECHNICAL QUESTIONS',
    ...p.technical.map((t) => `- ${t.question}\n  Emphasise: ${t.hint}`),
    '',
    'BEHAVIOURAL QUESTIONS',
    ...p.behavioural.map((b) => `- ${b.question}\n${star(b).replace(/^/gm, '  ')}`),
    '',
    'COMPANY BRIEF',
    p.company.brief,
    ...p.company.verify.map((v) => `- ${v}`),
    '',
    'QUESTIONS TO ASK',
    ...p.questions_to_ask.map((q) => `- ${q}`),
    '',
    'REQUIREMENTS',
    ...p.requirements.map((r) => `- ${r.requirement}: ${r.gap ? 'GAP — ' : ''}${r.evidence}`),
  ].join('\n');
}

function PrepButton({ id, label }: { id: string; label: string }) {
  return <ActionForm action={prepareInterview} fields={{ id }} pendingText="Starting…" label={label} />;
}

const card = 'space-y-1 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800';

/**
 * Interview prep for jobs in `applied` or `interview` (and any job that already has one).
 * `busy`: the job's running background tasks; a running `prep` replaces the button. With the AI off (`ai`), a note
 * linking to Settings replaces it.
 */
export function InterviewPrep({ job, busy = [], ai = true }: { job: Job; busy?: readonly TaskKind[]; ai?: boolean }) {
  const p = job.interview_prep;
  if (!p && job.status !== 'applied' && job.status !== 'interview') return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          Interview prep{' '}
          <span className="text-xs font-normal text-zinc-500">
            · AI, from this job description and your CV{job.interview_prep_at && ` · ${fmtDate(job.interview_prep_at)}`}
          </span>
        </h2>
        <div className="flex gap-2">
          {busy.includes('prep') ? (
            <Busy>Preparing interview notes…</Busy>
          ) : ai ? (
            <PrepButton id={job.id} label={p ? 'Regenerate' : 'Prepare for interview'} />
          ) : (
            <AiOffNote what="interview prep" />
          )}
          {p && <CopyButton text={prepText(p)} label="Copy all" />}
        </div>
      </div>

      {p && (
        <>
          <div className="space-y-2">
            <h3 className="text-sm font-medium">Technical questions</h3>
            <ul className="space-y-2">
              {p.technical.map((t, i) => (
                <li key={i} className={card}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{t.question}</p>
                    <CopyButton text={`${t.question}\nEmphasise: ${t.hint}`} />
                  </div>
                  <p className="text-zinc-600 dark:text-zinc-400">💡 {t.hint}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Behavioural questions (STAR stories from your CV)</h3>
            <ul className="space-y-2">
              {p.behavioural.map((b, i) => (
                <li key={i} className={card}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium">{b.question}</p>
                    <CopyButton text={`${b.question}\n${star(b)}`} />
                  </div>
                  <p className="whitespace-pre-line">{star(b)}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className={card}>
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-medium">
                Company brief <span className="text-xs font-normal text-zinc-500">· from the posting only, no web research</span>
              </h3>
              <CopyButton text={p.company.brief} />
            </div>
            <p>{p.company.brief}</p>
            {p.company.verify.length > 0 && (
              <ul className="list-disc pl-5 text-amber-700 dark:text-amber-400">
                {p.company.verify.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ul>
            )}
          </div>

          <div className={card}>
            <div className="flex items-start justify-between gap-3">
              <h3 className="font-medium">Questions to ask them</h3>
              <CopyButton text={p.questions_to_ask.map((q) => `- ${q}`).join('\n')} />
            </div>
            <ul className="list-disc pl-5">
              {p.questions_to_ask.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          </div>

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Requirements vs your CV</h3>
            <ul className="space-y-1 text-sm">
              {p.requirements.map((r, i) => (
                <li key={i} className={r.gap ? 'text-rose-700 dark:text-rose-400' : ''}>
                  {r.gap ? '✗' : '✓'} <b>{r.requirement}</b>: {r.gap && 'gap — '}
                  {r.evidence}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
