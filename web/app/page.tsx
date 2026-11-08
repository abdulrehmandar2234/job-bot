import Form from 'next/form';
import Link from 'next/link';
import { Fragment, Suspense } from 'react';
import { fetchNow } from './actions';
import {
  countJobs,
  followUpCount,
  lastRun,
  listJobs,
  PAGE_SIZE as PAGE_SIZE_DEFAULT,
  PAGE_SIZES,
  pageSize,
  postingsFor,
  STATUSES,
  statusCounts,
  weekStats,
  type Status,
} from '@/lib/db';
import { ActionForm } from '@/components/action-form';
import { FetchWarning } from '@/components/analytics';
import { BaytBookmarklet } from '@/components/client';
import { JobActions } from '@/components/job-actions';
import { TaskBar } from '@/components/tasks';
import { isActive, openTasks } from '@/lib/tasks';
import { SalaryFilter, SalaryOnlyToggle, salaryParams, SalaryTag } from '@/components/salary';
import { defaultCurrency, loadExpectations } from '@/lib/salary';
import { aiEnabled } from '@/lib/settings';
import { ReferralBadge } from '@/components/contacts';
import { allContacts } from '@/lib/contacts-db';
import { ExpiredBadge } from '@/components/open-check';
import { FollowUpBadge } from '@/components/follow-up';
import { Pager } from '@/components/pager';
import { AutoCheckbox, AutoSelect } from '@/components/auto-submit';
import { VisaBadge } from '@/components/visa';
import { ago, AiReview, Chips, fmtDate, Posted, PostedOn, Score, STATUS_LABEL } from '@/components/ui';
import { FirstRunBanner, MarketHeader } from '@/components/profile-banner';
import { readCountryLabels } from '@/lib/profile';
import { DEFAULT_DAYS, postedDays } from '@/lib/filter-memory';

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
          <ActionForm action={fetchNow} pendingText="Starting…" buttonClass="btn-primary" label="Fetch new jobs" />
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
  // "Needs follow-up" is a view of applied jobs (src/followup.ts), not a status of its own.
  const followUp = one('view') === 'followup';
  const status = followUp ? 'applied' : ((STATUSES.includes(one('status') as Status) ? one('status') : 'new') as Status);
  const labels = readCountryLabels(); // config.json target countries, plus RM for remote
  const country = one('country') && labels[one('country')!] ? one('country') : undefined;
  const min = Number(one('min')) || undefined;
  const q = one('q');
  // A search looks in every tab (each card says which), unless "only in this tab" was chosen (in=tab).
  const onlyTab = one('in') === 'tab';
  // Absent: the last 24 hours (DEFAULT_DAYS); 0 is "any time". proxy.ts keeps the chosen filters across visits.
  const days = postedDays(Array.isArray(sp.days) ? sp.days[0] : sp.days);
  const sort = one('sort') === 'newest' ? 'newest' : 'score';
  const visaOnly = one('visa') === '1';
  const salary = salaryParams(one, defaultCurrency());
  const expected = loadExpectations();
  const ai = aiEnabled(); // config.json ai.enabled: off hides the AI review buttons
  const page = Math.max(1, Math.floor(Number(one('page'))) || 1);
  const size = pageSize(one('size'));
  const everyTab = Boolean(q) && !followUp && !onlyTab;
  // "Posted within" narrows the Matching tab only: in the pipeline tabs (Applied, Interview, ...) and a search across
  // every tab, a job's age is not a reason to hide it.
  const postedFilter = status === 'new' && !followUp && !everyTab ? days : undefined;
  const filter = { status, country, min, q, days: postedFilter, sort, followUp, visaOnly, everyTab, ...salary.filter } as const;

  const [jobs, total, counts, run, week, tasks, dueCount] = await Promise.all([
    listJobs(filter, page, size),
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
  // While searching, a tab link narrows the search to that tab (in=tab); page links keep the current scope.
  const tabParams = (s: string, view?: 'followup', toPage = 1, scope: 'tab' | 'keep' = 'tab') =>
    new URLSearchParams({
      ...(view ? { view } : { status: s }),
      ...(country && { country }),
      ...(min && { min: String(min) }),
      ...(q && { q }),
      ...(q && (scope === 'tab' || onlyTab) && { in: 'tab' }),
      ...(days !== DEFAULT_DAYS && { days: String(days ?? 0) }),
      ...(sort === 'newest' && { sort }),
      ...(visaOnly && { visa: '1' }),
      ...salary.query,
      ...(size !== PAGE_SIZE_DEFAULT && { size: String(size) }),
      ...(toPage > 1 && { page: String(toPage) }),
    });
  const tabHref = (s: string, view?: 'followup', toPage = 1, scope: 'tab' | 'keep' = 'tab') => `/?${tabParams(s, view, toPage, scope)}`;
  const pageHref = (n: number) => tabHref(status, followUp ? 'followup' : undefined, n, 'keep');
  // The same search in every tab: the current URL without in=tab and page.
  const everyTabHref = () => {
    const p = tabParams(status, undefined, 1, 'keep');
    p.delete('in');
    return `/?${p}`;
  };

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
        className="scroll-x-hint mb-4 flex gap-1 overflow-x-auto [scrollbar-width:none] border-b border-zinc-200 dark:border-zinc-800"
      >
        {STATUSES.map((s) => (
          <Fragment key={s}>
            <Link
              href={tabHref(s)}
              aria-current={!followUp && !everyTab && s === status ? 'page' : undefined}
              className={tabClass(!followUp && !everyTab && s === status)}
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

      {q && !followUp && (
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          {everyTab ? (
            <>
              Results for <b>“{q}”</b> in every tab ·{' '}
              <Link href={tabHref(status)} className="underline">
                Search only in {STATUS_LABEL[status]}
              </Link>
            </>
          ) : (
            <>
              Results for <b>“{q}”</b> in {STATUS_LABEL[status]} only ·{' '}
              <Link href={everyTabHref()} className="underline">
                Search every tab
              </Link>
            </>
          )}
        </p>
      )}

      {/* Row 1: the text filters and Apply; row 2: the selects, then the two "only jobs with ..." toggles, each group
          wrapping as a unit. Every control is h-9 so the rows line up.
          The choices apply on change (AutoSelect / AutoCheckbox); typed text waits for Apply filters, which also
          sends everything without JS.
          next/form turns the GET submit into a client-side navigation: only the list re-renders, with no full page
          load, and the scroll position stays. The key remounts it when the URL changes some other way (a tab link,
          Back), so its uncontrolled fields show the filters in the URL again. */}
      <Form
        key={JSON.stringify(sp)}
        action="/"
        scroll={false}
        aria-label="Job filters"
        className="mb-4 space-y-2 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800"
      >
        {followUp ? <input type="hidden" name="view" value="followup" /> : <input type="hidden" name="status" value={status} />}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search company or title"
            aria-label="Search company or title"
            className="input h-9 w-full sm:w-auto sm:min-w-56 sm:flex-1"
          />
          <SalaryFilter params={salary.params} />
          <button type="submit" className="btn ml-auto h-9">
            Apply filters
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <AutoSelect name="country" defaultValue={country ?? ''} aria-label="Country" className="input h-9">
              <option value="">All countries</option>
              {Object.entries(labels).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </AutoSelect>
            <AutoSelect name="min" defaultValue={min ?? ''} aria-label="Minimum score" className="input h-9">
              <option value="">Any score</option>
              {[50, 60, 70, 80].map((n) => (
                <option key={n} value={n}>
                  Score ≥ {n}
                </option>
              ))}
            </AutoSelect>
            <AutoSelect
              name="days"
              defaultValue={days ?? 0}
              aria-label="Posted within"
              title="Applies to the Matching tab"
              className="input h-9"
            >
              <option value="0">Posted: any time</option>
              <option value="1">Last 24 hours</option>
              <option value="3">Last 3 days</option>
              <option value="7">Last 7 days</option>
            </AutoSelect>
            <AutoSelect name="sort" defaultValue={sort} aria-label="Sort" className="input h-9">
              <option value="score">Best match first</option>
              <option value="newest">Newest first</option>
            </AutoSelect>
            <AutoSelect name="size" defaultValue={size} aria-label="Jobs per page" className="input h-9">
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n} per page
                </option>
              ))}
            </AutoSelect>
          </div>
          <div data-testid="filter-toggles" className="flex flex-wrap items-center gap-2">
            <SalaryOnlyToggle params={salary.params} />
            {/* biome-ignore lint/a11y/noLabelWithoutControl: AutoCheckbox renders the checkbox input */}
            <label className="toggle">
              <AutoCheckbox name="visa" value="1" defaultChecked={visaOnly} />
              Visa/relocation offered (or not needed)
            </label>
          </div>
        </div>
      </Form>

      <Pager page={page} total={total} pageSize={size} href={pageHref} />

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
                    {everyTab && j.status !== 'expired' && <StatusTag status={j.status} />}
                    <FollowUpBadge job={j} />
                  </Link>
                  <span className="text-xs text-zinc-500">
                    <Posted date={j.posted_at} />
                    {j.applied_at && ` · applied ${fmtDate(j.applied_at)}`}
                  </span>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400">
                  {j.country ? (labels[j.country] ?? j.country) : ''} · {j.location}
                  {(j.visa || j.visa_evidence) && (
                    <>
                      {' · '}
                      <VisaBadge job={j} />
                    </>
                  )}
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
                <JobActions job={j} busy={busy(j.id)} ai={ai} />
              </div>
            </div>
          </li>
        ))}
      </ul>

      <Pager page={page} total={total} pageSize={size} href={pageHref} />
    </>
  );
}

/** On search results from every tab: which tab the job is in. */
function StatusTag({ status }: { status: Status }) {
  return (
    <span
      title="The tab this job is in"
      className="ml-1 rounded-full bg-zinc-200 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
    >
      {STATUS_LABEL[status]}
    </span>
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
