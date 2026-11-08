import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import {
  clearAnswers,
  draftAnswers,
  rewriteLetter,
  rewriteSummary,
  saveLetter,
  saveNotes,
  saveSummary,
  tailorCv,
  writeLetter,
  writeSummary,
} from '@/app/actions';
import { getJob, type Job, jobEvents, postingsFor } from '@/lib/db';
import { isActive, openTasks } from '@/lib/tasks';
import { ActionForm } from '@/components/action-form';
import { CopyButton } from '@/components/client';
import { CvAction, OpenJobLink, StatusActions } from '@/components/job-actions';
import { Collapsible, FoldedText } from '@/components/collapsible';
import { InterviewPrep } from '@/components/interview-prep';
import { FollowUp } from '@/components/follow-up';
import { Busy, TaskBar } from '@/components/tasks';
import { WrittenText } from '@/components/written-text';
import { SalaryTag } from '@/components/salary';
import { AtsCheck } from '@/components/ats-check';
import { CV_TASKS, CvPanel } from '@/components/cv-panel';
import { loadExpectations } from '@/lib/salary';
import { Contacts, ReferralReminder } from '@/components/contacts';
import { allContacts } from '@/lib/contacts-db';
import { SKIP_LABEL } from '@/lib/skips';
import { ExpiredBadge, OpenCheck } from '@/components/open-check';
import { VisaBadge } from '@/components/visa';
import { Chips, fmtDate, Posted, PostedOn, Score, STATUS_LABEL } from '@/components/ui';
import { readCountryLabels } from '@/lib/profile';
import { aiEnabled } from '@/lib/settings';
import { AiOffNote } from '@/components/ai-off';

export default function Page(props: PageProps<'/jobs/[id]'>) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All jobs
      </Link>
      <Suspense fallback={<p className="mt-4 text-sm text-zinc-500">Loading…</p>}>
        <JobDetail params={props.params} />
      </Suspense>
    </div>
  );
}

const card = 'space-y-3 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800';
const navLink = 'rounded-full border border-zinc-200 px-2.5 py-0.5 hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-900';
const LONG_DESCRIPTION = 600; // characters; shorter descriptions are shown in full

/** Shows a job's preview only when it is long enough to fold. */
function Description({ text }: { text: string }) {
  const box = 'rounded-xl border border-zinc-200 p-4 text-sm leading-relaxed dark:border-zinc-800';
  if (!text.trim()) return <p className="text-sm text-zinc-500">No description saved for this job.</p>;
  if (text.length <= LONG_DESCRIPTION) return <div className={`whitespace-pre-line ${box}`}>{text}</div>;
  return (
    <div className={box}>
      <FoldedText preview={text} label="description">
        <div className="whitespace-pre-line">{text}</div>
      </FoldedText>
    </div>
  );
}

/** The keyword match from scoring: what you have, what is missing, warnings and why a job was filtered out. */
function SkillsMatch({ job }: { job: Job }) {
  if (!job.matched.length && !job.missing.length && !job.flags.length && !job.filter_reason) return null;
  const counts = [
    `${job.matched.length} you have`,
    `${job.missing.length} missing`,
    job.flags.length > 0 && `${job.flags.length} warning${job.flags.length > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return (
    <Collapsible
      id="skills"
      title={
        <>
          Skills match <span className="text-xs font-normal text-zinc-500">· {counts.join(' · ')}</span>
        </>
      }
      hint={job.filter_reason && <span className="text-rose-700 dark:text-rose-400">✗ Filtered: {job.filter_reason}</span>}
    >
      <div>
        <span className="text-zinc-500">You have:</span> <Chips items={job.matched} tone="good" />
      </div>
      {job.missing.length > 0 && (
        <div>
          <span className="text-zinc-500">Missing:</span> <Chips items={job.missing} tone="bad" />
        </div>
      )}
      {job.flags.length > 0 && (
        <div>
          <span className="text-zinc-500">Warnings:</span> <Chips items={job.flags} tone="warn" />
        </div>
      )}
    </Collapsible>
  );
}

/** The AI's verdict and one-line summary stay visible; why it fits, gaps and blockers fold away. */
function AiReviewFold({ job }: { job: Job }) {
  if (job.ai_score == null) return null;
  return (
    <Collapsible
      id="ai-review"
      title={
        <>
          AI review <span className="text-xs font-normal text-zinc-500">· {job.ai_verdict}</span>
        </>
      }
      hint={job.ai_summary}
    >
      <Chips items={(job.ai_reasons ?? []).map((r) => `✓ ${r}`)} tone="good" />
      <Chips items={(job.ai_gaps ?? []).map((g) => `– ${g}`)} tone="bad" />
      <Chips items={(job.ai_flags ?? []).map((f) => `⚠ ${f}`)} tone="warn" />
    </Collapsible>
  );
}

async function JobDetail({ params }: { params: PageProps<'/jobs/[id]'>['params'] }) {
  const id = decodeURIComponent((await params).id);
  const [job, events, tasks, contacts] = await Promise.all([getJob(id), jobEvents(id), openTasks(id), allContacts()]);
  if (!job) notFound();
  const busy = tasks.filter(isActive).map((t) => t.kind);
  const primaryId = job.duplicate_of ?? job.id;
  const postings = (await postingsFor([primaryId])).get(primaryId) ?? [];
  const answers = job.form_answers ?? [];
  // Same rule as <InterviewPrep>, for the section link.
  const hasPrep = Boolean(job.interview_prep) || job.status === 'applied' || job.status === 'interview';
  // config.json ai.enabled: off hides the AI-only buttons, each with a note linking to Settings. "Write letter" and
  // the follow-up draft stay: the bot falls back to its templates for them.
  const ai = aiEnabled();

  return (
    <div className="mt-4 space-y-4">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold">
          {job.title} <ExpiredBadge job={job} />
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          {job.company} · {job.country ? (readCountryLabels()[job.country] ?? job.country) : ''} · {job.location}
        </p>
      </header>

      <TaskBar tasks={tasks} job={job.id} />

      {/* The sidebar comes first in the DOM so phones show the summary and actions before the long texts. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-8 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <aside
          aria-label="Job summary and actions"
          className="space-y-4 lg:sticky lg:top-4 lg:col-start-2 lg:row-start-1 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:pr-1"
        >
          <section aria-labelledby="job-summary-heading" className={card}>
            <h2 id="job-summary-heading" className="sr-only">
              Job summary
            </h2>
            <div className="flex items-center gap-3">
              <Score value={job.score} ai={job.ai_score} />
              <div className="space-y-0.5">
                <p>
                  Status: <b>{STATUS_LABEL[job.status]}</b>
                </p>
                <p className="text-xs text-zinc-500">
                  {job.ai_score != null ? `AI score ${job.ai_score} · keyword score ${job.score}` : `Keyword score ${job.score}`}
                </p>
              </div>
            </div>
            <div className="space-y-1">
              <SalaryTag job={job} expected={loadExpectations()} />
              {(job.visa || job.visa_evidence) && (
                <p>
                  <VisaBadge job={job} />
                  {/* Without a label the badge already shows the note itself. */}
                  {job.visa_evidence && job.visa && <span className="text-zinc-500"> · {job.visa}</span>}
                </p>
              )}
              <p className="text-zinc-500">
                <Posted date={job.posted_at} /> · first seen {fmtDate(job.first_seen_at)}
                {job.applied_at && <> · applied {fmtDate(job.applied_at)}</>}
              </p>
              <PostedOn postings={postings} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <OpenJobLink job={job} />
              <StatusActions job={job} busy={busy} ai={ai} />
            </div>
            {!ai && job.ai_score == null && <AiOffNote what="the AI review" />}
            <OpenCheck job={job} />
          </section>

          <ReferralReminder job={job} contacts={contacts} />

          {/* CV block: the CV for this job. CV template choices belong here too. */}
          <section id="cv" aria-labelledby="cv-heading" className={card}>
            <h2 id="cv-heading" className="font-medium">
              CV <span className="text-xs font-normal text-zinc-500">· suggested version: {job.cluster ?? 'default'}</span>
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <CvAction job={job} busy={busy} />
            </div>
          </section>
          <FollowUp job={job} busy={busy} />

          <Contacts job={job} contacts={contacts} />

          <section className="space-y-2">
            <h2 className="font-medium">Notes</h2>
            <ActionForm action={saveNotes} fields={{ id: job.id }} className="space-y-2" pendingText="Saving…" label="Save notes">
              <textarea
                name="notes"
                aria-label="Job notes"
                defaultValue={job.notes ?? ''}
                rows={3}
                className="input w-full"
                placeholder="Recruiter name, salary, interview date…"
              />
            </ActionForm>
          </section>

          {events.length > 0 && (
            <Collapsible
              id="history"
              title={
                <>
                  History{' '}
                  <span className="text-xs font-normal text-zinc-500">
                    · {events.length} change{events.length > 1 ? 's' : ''}
                  </span>
                </>
              }
            >
              <ul className="space-y-1 text-zinc-600 dark:text-zinc-400">
                {events.map((e) => (
                  <li key={e.id}>
                    {new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} — {e.from_status ?? '—'} →{' '}
                    <b>{e.to_status}</b>
                    {e.reason && ` · ${SKIP_LABEL[e.reason]}`}
                    {e.note && ` (${e.note})`}
                  </li>
                ))}
              </ul>
            </Collapsible>
          )}
        </aside>

        <main className="min-w-0 space-y-6 lg:col-start-1 lg:row-start-1">
          <nav aria-label="Sections on this page" className="flex flex-wrap gap-2 text-xs text-zinc-600 dark:text-zinc-400">
            <a href="#letter" className={navLink}>
              Cover letter
            </a>
            <a href="#cv-summary" className={navLink}>
              CV summary
            </a>
            <a href="#cv-panel" className={navLink}>
              CV template
            </a>
            <a href="#answers" className={navLink}>
              Form answers
            </a>
            {hasPrep && (
              <a href="#prep" className={navLink}>
                Interview prep
              </a>
            )}
            <a href="#description" className={navLink}>
              Job description
            </a>
          </nav>

          <div className="space-y-2">
            <AiReviewFold job={job} />
            <SkillsMatch job={job} />
            <AtsCheck jobId={job.id} cvVersion={job.cv_version ?? job.cluster} confirm={ai && !CV_TASKS.some((k) => busy.includes(k))} />
          </div>

          <section id="letter" className="scroll-mt-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">
                Cover letter{' '}
                <span className="text-xs font-normal text-zinc-500">
                  {!job.cover_letter
                    ? '· not written yet'
                    : job.cover_letter_edited_at
                      ? '· edited by you'
                      : job.cover_letter_ai
                        ? '· written by AI from this job description'
                        : '· template'}
                </span>
              </h2>
              <div className="flex gap-2">
                {/* Written only on request, never by Prepare: many applications do not ask for a letter. */}
                {busy.includes('letter') ? (
                  <Busy>{job.cover_letter ? 'Rewriting letter…' : 'Writing letter…'}</Busy>
                ) : (
                  <ActionForm
                    action={writeLetter}
                    fields={{ id: job.id }}
                    pendingText="Starting…"
                    label={job.cover_letter ? 'Rewrite letter' : 'Write letter'}
                  />
                )}
                {job.cover_letter && <CopyButton text={job.cover_letter} />}
                {job.cover_letter && !busy.includes('letter') && (
                  <a href={`/api/letter/${encodeURIComponent(job.id)}`} className="btn">
                    Download PDF ↓
                  </a>
                )}
              </div>
            </div>
            {job.cover_letter && !job.cover_letter_ai && !job.cover_letter_edited_at && job.cover_letter_ai_error && (
              <p
                role="note"
                className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30"
              >
                <span className="font-medium">The AI could not write this letter, so this is the template letter.</span>{' '}
                {job.cover_letter_ai_error}
              </p>
            )}
            {job.cover_letter && (
              <FoldedText preview={job.cover_letter} label="letter">
                <WrittenText
                  id={job.id}
                  kind="letter"
                  text={job.cover_letter}
                  busy={busy.includes('letter')}
                  save={saveLetter}
                  rewrite={rewriteLetter}
                  ai={ai}
                />
              </FoldedText>
            )}
          </section>

          <section id="cv-summary" className="scroll-mt-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">
                CV summary for this job{' '}
                <span className="text-xs font-normal text-zinc-500">
                  {!job.cv_summary ? '· not written yet' : job.cv_summary_edited_at ? '· edited by you' : '· written by AI for this job'}
                </span>
              </h2>
              <div className="flex flex-wrap gap-2">
                {busy.includes('summary') ? (
                  <Busy>{job.cv_summary ? 'Rewriting summary…' : 'Writing summary…'}</Busy>
                ) : (
                  ai && (
                    <ActionForm
                      action={writeSummary}
                      fields={{ id: job.id }}
                      pendingText="Starting…"
                      label={job.cv_summary ? 'Rewrite summary' : 'Write summary'}
                    />
                  )
                )}
                {job.cv_summary && <CopyButton text={job.cv_summary} />}
                {job.cv_summary &&
                  (busy.includes('tailored_cv') ? (
                    <Busy>Building CV with this summary…</Busy>
                  ) : (
                    !busy.includes('summary') && (
                      <ActionForm action={tailorCv} fields={{ id: job.id }} pendingText="Starting…" label="Use in my CV for this job" />
                    )
                  ))}
              </div>
            </div>
            {job.cv_summary ? (
              <WrittenText
                id={job.id}
                kind="summary"
                text={job.cv_summary}
                busy={busy.includes('summary') || busy.includes('tailored_cv')}
                save={saveSummary}
                rewrite={rewriteSummary}
                ai={ai}
              />
            ) : !ai ? (
              <AiOffNote what="writing a CV summary for this job" />
            ) : (
              <p className="text-sm text-zinc-500">
                The summary at the top of your CV, rewritten for this job from your CV and the job description. Only facts from your CV.
              </p>
            )}
          </section>

          <section id="cv-panel" className="scroll-mt-4">
            <CvPanel job={job} busy={busy} ai={ai} />
          </section>

          <section id="answers" className="scroll-mt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">
                Application form answers <span className="text-xs font-normal text-zinc-500">· AI drafts, you review and paste</span>
              </h2>
              {answers.length > 0 && <ActionForm action={clearAnswers} fields={{ id: job.id }} pendingText="Clearing…" label="Clear all" />}
            </div>
            {answers.length > 0 && (
              <ul className="space-y-3">
                {answers.map((a, i) => (
                  <li
                    key={i}
                    className={`space-y-1 rounded-xl border p-3 text-sm ${
                      a.needs_input
                        ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
                        : 'border-zinc-200 dark:border-zinc-800'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-medium">{a.question}</p>
                      <CopyButton text={a.answer} />
                    </div>
                    <p className="whitespace-pre-line">{a.answer}</p>
                    {a.note && <p className="text-xs text-zinc-500">💡 {a.note}</p>}
                  </li>
                ))}
              </ul>
            )}
            {answers.some((a) => a.needs_input) && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Yellow answers need your input. Add salary, notice period etc. to <code>cv/applicant.json</code> once and they fill in next
                time.
              </p>
            )}
            {!ai ? (
              <AiOffNote what="drafting answers" />
            ) : (
              <ActionForm
                action={draftAnswers}
                fields={{ id: job.id }}
                className="space-y-2"
                pendingText="Starting…"
                label="Draft answers"
                busy={busy.includes('answers') ? <Busy>Drafting answers…</Busy> : undefined}
              >
                <textarea
                  name="questions"
                  aria-label="Application form questions"
                  rows={4}
                  required
                  className="input w-full"
                  placeholder={
                    'Paste the questions from the application form, e.g.\nHow many years of experience do you have with Laravel?\nDo you require visa sponsorship? Yes / No\nWhy do you want to work with us?'
                  }
                />
              </ActionForm>
            )}
          </section>

          <div id="prep" className="scroll-mt-4 empty:hidden">
            <InterviewPrep job={job} busy={busy} ai={ai} />
          </div>

          <section id="description" className="scroll-mt-4 space-y-2">
            <h2 className="font-medium">Job description</h2>
            <Description text={job.description} />
          </section>
        </main>
      </div>
    </div>
  );
}
