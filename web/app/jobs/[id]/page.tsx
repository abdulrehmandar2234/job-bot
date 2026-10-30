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
import { getJob, jobEvents, postingsFor } from '@/lib/db';
import { isActive, openTasks } from '@/lib/tasks';
import { CopyButton, SubmitButton } from '@/components/client';
import { JobActions } from '@/components/job-actions';
import { InterviewPrep } from '@/components/interview-prep';
import { FollowUp } from '@/components/follow-up';
import { Busy, TaskBar } from '@/components/tasks';
import { WrittenText } from '@/components/written-text';
import { SalaryTag } from '@/components/salary';
import { AtsCheck } from '@/components/ats-check';
import { loadExpectations } from '@/lib/salary';
import { Contacts, ReferralReminder } from '@/components/contacts';
import { allContacts } from '@/lib/contacts-db';
import { SKIP_LABEL } from '@/lib/skips';
import { ExpiredBadge, OpenCheck } from '@/components/open-check';
import { AiReview, Chips, fmtDate, Posted, PostedOn, Score, STATUS_LABEL } from '@/components/ui';
import { readCountryLabels } from '@/lib/profile';

export default function Page(props: PageProps<'/jobs/[id]'>) {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All jobs
      </Link>
      <Suspense fallback={<p className="mt-4 text-sm text-zinc-500">Loading…</p>}>
        <JobDetail params={props.params} />
      </Suspense>
    </main>
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

  return (
    <article className="mt-4 space-y-6">
      <header className="flex gap-4">
        <Score value={job.score} ai={job.ai_score} />
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">
            {job.title} <ExpiredBadge job={job} />
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400">
            {job.company} · {job.country ? (readCountryLabels()[job.country] ?? job.country) : ''} · {job.location}
          </p>
          <p className="text-sm text-zinc-500">
            Status: <b>{STATUS_LABEL[job.status]}</b> · <Posted date={job.posted_at} /> · first seen {fmtDate(job.first_seen_at)}
            {job.applied_at && <> · applied {fmtDate(job.applied_at)}</>} · suggested CV: {job.cluster ?? 'default'}
          </p>
          <SalaryTag job={job} expected={loadExpectations()} />
          <PostedOn postings={postings} />
        </div>
      </header>

      <TaskBar tasks={tasks} job={job.id} />

      <JobActions job={job} busy={busy} />
      <OpenCheck job={job} />

      <ReferralReminder job={job} contacts={contacts} />
      <FollowUp job={job} busy={busy} />

      <AiReview job={job} />

      <InterviewPrep job={job} busy={busy} />
      <AtsCheck jobId={job.id} />

      <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        {job.visa && <p className="text-emerald-700 dark:text-emerald-400">✓ Visa: {job.visa}</p>}
        {job.filter_reason && <p className="text-rose-700 dark:text-rose-400">✗ Filtered: {job.filter_reason}</p>}
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
      </section>

      <section className="space-y-2">
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
              <form action={writeLetter}>
                <input type="hidden" name="id" value={job.id} />
                <SubmitButton pendingText="Starting…">{job.cover_letter ? 'Rewrite letter' : 'Write letter'}</SubmitButton>
              </form>
            )}
            {job.cover_letter && <CopyButton text={job.cover_letter} />}
            {job.cover_letter && !busy.includes('letter') && (
              <a href={`/api/letter/${encodeURIComponent(job.id)}`} className="btn">
                Download PDF ↓
              </a>
            )}
          </div>
        </div>
        {job.cover_letter && (
          <WrittenText
            id={job.id}
            kind="letter"
            text={job.cover_letter}
            busy={busy.includes('letter')}
            save={saveLetter}
            rewrite={rewriteLetter}
          />
        )}
      </section>

      <section className="space-y-2">
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
              <form action={writeSummary}>
                <input type="hidden" name="id" value={job.id} />
                <SubmitButton pendingText="Starting…">{job.cv_summary ? 'Rewrite summary' : 'Write summary'}</SubmitButton>
              </form>
            )}
            {job.cv_summary && <CopyButton text={job.cv_summary} />}
            {job.cv_summary &&
              (busy.includes('tailored_cv') ? (
                <Busy>Building CV with this summary…</Busy>
              ) : (
                !busy.includes('summary') && (
                  <form action={tailorCv}>
                    <input type="hidden" name="id" value={job.id} />
                    <SubmitButton pendingText="Starting…">Use in my CV for this job</SubmitButton>
                  </form>
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
          />
        ) : (
          <p className="text-sm text-zinc-500">
            The summary at the top of your CV, rewritten for this job from your CV and the job description. Only facts from your CV.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">
            Application form answers <span className="text-xs font-normal text-zinc-500">· AI drafts, you review and paste</span>
          </h2>
          {answers.length > 0 && (
            <form action={clearAnswers}>
              <input type="hidden" name="id" value={job.id} />
              <SubmitButton pendingText="Clearing…">Clear all</SubmitButton>
            </form>
          )}
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
        <form action={draftAnswers} className="space-y-2">
          <input type="hidden" name="id" value={job.id} />
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
          {busy.includes('answers') ? <Busy>Drafting answers…</Busy> : <SubmitButton pendingText="Starting…">Draft answers</SubmitButton>}
        </form>
      </section>

      <Contacts job={job} contacts={contacts} />

      <section className="space-y-2">
        <h2 className="font-medium">Notes</h2>
        <form action={saveNotes} className="space-y-2">
          <input type="hidden" name="id" value={job.id} />
          <textarea
            name="notes"
            aria-label="Job notes"
            defaultValue={job.notes ?? ''}
            rows={3}
            className="input w-full"
            placeholder="Recruiter name, salary, interview date…"
          />
          <SubmitButton pendingText="Saving…">Save notes</SubmitButton>
        </form>
      </section>

      {events.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-medium">History</h2>
          <ul className="space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
            {events.map((e) => (
              <li key={e.id}>
                {new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} — {e.from_status ?? '—'} →{' '}
                <b>{e.to_status}</b>
                {e.reason && ` · ${SKIP_LABEL[e.reason]}`}
                {e.note && ` (${e.note})`}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="font-medium">Job description</h2>
        <div className="whitespace-pre-line rounded-xl border border-zinc-200 p-4 text-sm leading-relaxed dark:border-zinc-800">
          {job.description}
        </div>
      </section>
    </article>
  );
}
