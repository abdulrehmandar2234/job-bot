import Link from 'next/link';
import { Fragment, Suspense } from 'react';
import { fetchNow } from './actions';
import {
  countJobs,
  followUpCount,
  lastRun,
  listJobs,
  PAGE_SIZE,
  postingsFor,
  STATUSES,
  statusCounts,
  weekStats,
  type Status,
} from '@/lib/db';
import { FetchWarning } from '@/components/analytics';
import { BaytBookmarklet, SubmitButton } from '@/components/client';
import { JobActions } from '@/components/job-actions';
import { TaskBar } from '@/components/tasks';
import { isActive, openTasks } from '@/lib/tasks';
import { SalaryFilter, salaryParams, SalaryTag } from '@/components/salary';
import { loadExpectations } from '@/lib/salary';
import { ReferralBadge } from '@/components/contacts';
import { allContacts } from '@/lib/contacts-db';
import { ExpiredBadge } from '@/components/open-check';
import { FollowUpBadge } from '@/components/follow-up';
import { Pager } from '@/components/pager';
import { ago, AiReview, Chips, fmtDate, Posted, PostedOn, Score, STATUS_LABEL } from '@/components/ui';
import { FirstRunBanner, MarketHeader } from '@/components/profile-banner';
import { readCountryLabels } from '@/lib/profile';

export default function Page(props: PageProps<'/'>) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Job Bot</h1>
          <Suspense fallback={<p className="text-sm text-zinc-500">&nbsp;</p>}>
            <MarketHeader />
          </Suspense>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Suspense fallback={null}>
            <FetchWarning />
          </Suspense>
          <Link href="/analytics" className="btn">
            Analytics
          </Link>
          <Link href="/settings" className="btn">
            Settings
          </Link>
          <form action={fetchNow}>
            <SubmitButton pendingText="Starting…" className="btn-primary">
              Fetch new jobs
            </SubmitButton>
          </form>
        </div>
      </header>
      <Suspense fallback={null}>
        <FirstRunBanner />
      </Suspense>
      <details className="mb-5 rounded-xl border border-zinc-200 px-4 py-3 text-sm dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">Add jobs from Bayt</summary>
        <div className="mt-3 space-y-3 text-zinc-600 dark:text-zinc-400">
          <p>Bayt blocks the bot, so Bayt jobs are collected from inside your browser:</p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              One time: drag this button to your bookmarks bar → <BaytBookmarklet />
            </li>
            <li>
              Open Bayt and click the <b>Bayt → Job Bot</b> bookmark. A progress box appears in the corner (takes ~10 min; keep the tab
              open).
            </li>
            <li>
              The first time, Chrome asks to allow bayt.com to reach this dashboard — click <b>Allow</b>.
            </li>
          </ol>
          <a href="https://www.bayt.com/en/uae/jobs/laravel-jobs/" target="_blank" rel="noreferrer" className="btn">
            Open Bayt ↗
          </a>
        </div>
      </details>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading jobs…</p>}>
        <Dashboard searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<'/'>['searchParams'] }) {
  const sp = await searchParams;
  const one = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) || undefined;
  // "Needs follow-up" is a view of applied jobs (web/lib/followup.ts), not a status of its own.
  const followUp = one('view') === 'followup';
  const status = followUp ? 'applied' : ((STATUSES.includes(one('status') as Status) ? one('status') : 'new') as Status);
  const labels = readCountryLabels(); // config.json target countries, plus RM for remote
  const country = one('country') && labels[one('country')!] ? one('country') : undefined;
  const min = Number(one('min')) || undefined;
  const q = one('q');
  const days = Number(one('days')) || undefined;
  const sort = one('sort') === 'newest' ? 'newest' : 'score';
  const salary = salaryParams(one);
  const expected = loadExpectations();
  const page = Math.max(1, Math.floor(Number(one('page'))) || 1);
  const filter = { status, country, min, q, days, sort, followUp, ...salary.filter } as const;

  const [jobs, total, counts, run, week, tasks, dueCount] = await Promise.all([
    listJobs(filter, page),
    countJobs(filter),
    statusCounts(),
    lastRun(),
    weekStats(),
    openTasks(),
    followUpCount(),
  ]);
  const busy = (id: string) => tasks.filter((t) => t.job_id === id && isActive(t)).map((t) => t.kind);
  const [postings, contacts] = await Promise.all([postingsFor(jobs.map((j) => j.id)), allContacts()]);
  // Tabs and filters start again at page 1; the page links keep everything else.
  const tabHref = (s: string, view?: 'followup', toPage = 1) => {
    const p = new URLSearchParams({
      ...(view ? { view } : { status: s }),
      ...(country && { country }),
      ...(min && { min: String(min) }),
      ...(q && { q }),
      ...(days && { days: String(days) }),
      ...(sort === 'newest' && { sort }),
      ...salary.query,
      ...(toPage > 1 && { page: String(toPage) }),
    });
    return `/?${p}`;
  };
  const pageHref = (n: number) => tabHref(status, followUp ? 'followup' : undefined, n);

  return (
    <>
      <TaskBar tasks={tasks} />
      <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Matching now" value={counts.new ?? 0} />
        <Stat label="New today" value={week.new_today} />
        <Stat label="Applied (7 days)" value={week.applied_week} />
        <Stat label="Last fetch" value={ago(run?.finished_at ?? null)} sub={run ? `${run.checked} postings checked` : 'run Fetch'} />
      </section>

      <nav
        aria-label="Job status"
        className="mb-4 flex gap-1 overflow-x-auto [scrollbar-width:none] border-b border-zinc-200 dark:border-zinc-800"
      >
        {STATUSES.map((s) => (
          <Fragment key={s}>
            <Link
              href={tabHref(s)}
              aria-current={!followUp && s === status ? 'page' : undefined}
              className={tabClass(!followUp && s === status)}
            >
              {STATUS_LABEL[s]} <span className="text-zinc-400">{counts[s] ?? 0}</span>
            </Link>
            {s === 'applied' && (
              <Link href={tabHref(s, 'followup')} aria-current={followUp ? 'page' : undefined} className={tabClass(followUp)}>
                Needs follow-up <span className={dueCount ? 'text-amber-600' : 'text-zinc-400'}>{dueCount}</span>
              </Link>
            )}
          </Fragment>
        ))}
      </nav>

      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        {followUp ? <input type="hidden" name="view" value="followup" /> : <input type="hidden" name="status" value={status} />}
        <input
          type="search"
          name="q"
          defaultValue={q}
          placeholder="Search company or title"
          aria-label="Search company or title"
          className="input w-56"
        />
        <select name="country" defaultValue={country ?? ''} aria-label="Country" className="input">
          <option value="">All countries</option>
          {Object.entries(labels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select name="min" defaultValue={min ?? ''} aria-label="Minimum score" className="input">
          <option value="">Any score</option>
          {[50, 60, 70, 80].map((n) => (
            <option key={n} value={n}>
              Score ≥ {n}
            </option>
          ))}
        </select>
        <select name="days" defaultValue={days ?? ''} aria-label="Posted within" className="input">
          <option value="">Posted: any time</option>
          <option value="1">Last 24 hours</option>
          <option value="3">Last 3 days</option>
          <option value="7">Last 7 days</option>
        </select>
        <select name="sort" defaultValue={sort} aria-label="Sort" className="input">
          <option value="score">Best match first</option>
          <option value="newest">Newest first</option>
        </select>
        <SalaryFilter params={salary.params} />
        <button type="submit" className="btn">
          Apply filters
        </button>
      </form>

      <Pager page={page} total={total} pageSize={PAGE_SIZE} href={pageHref} />

      {jobs.length === 0 && (
        <p className="py-10 text-center text-sm text-zinc-500">
          {followUp ? 'No follow-ups due: every application has had news or was sent less than a week ago.' : 'No jobs here.'}
        </p>
      )}

      <ul className="space-y-3">
        {jobs.map((j) => (
          <li key={j.id} className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex gap-3">
              <Score value={j.score} ai={j.ai_score} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <Link href={`/jobs/${encodeURIComponent(j.id)}`} className="font-medium hover:underline">
                    {j.title} <span className="text-zinc-500">· {j.company}</span> <ExpiredBadge job={j} />
                    <FollowUpBadge job={j} />
                  </Link>
                  <span className="text-xs text-zinc-500">
                    <Posted date={j.posted_at} />
                    {j.applied_at && ` · applied ${fmtDate(j.applied_at)}`}
                  </span>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {j.country ? (labels[j.country] ?? j.country) : ''} · {j.location}
                  {j.visa && <span className="text-emerald-700 dark:text-emerald-400"> · ✓ {j.visa}</span>}
                </p>
                <SalaryTag job={j} expected={expected} />
                <PostedOn postings={postings.get(j.id) ?? []} />
                <ReferralBadge job={j} contacts={contacts} />
                {j.filter_reason && <p className="text-sm text-rose-700 dark:text-rose-400">✗ {j.filter_reason}</p>}
                <AiReview job={j} />
                <Chips items={j.matched} tone="good" />
                <Chips items={j.missing} tone="bad" />
                <Chips items={j.flags} tone="warn" />
                {j.notes && <p className="whitespace-pre-line text-sm text-zinc-500">📝 {j.notes}</p>}
                <JobActions job={j} busy={busy(j.id)} />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Pager page={page} total={total} pageSize={PAGE_SIZE} href={pageHref} />
    </>
  );
}

const tabClass = (active: boolean) =>
  `whitespace-nowrap border-b-2 px-3 py-2 text-sm ${
    active
      ? 'border-zinc-900 font-medium dark:border-zinc-100'
      : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100'
  }`;

function Stat({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
