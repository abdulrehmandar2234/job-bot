import { salaryParams } from '@/components/salary';
import { type JobFilter, PAGE_SIZE, pageSize, STATUSES, type Status } from './db';
import { postedDays } from './filter-memory';
import { readCountryLabels } from './profile';
import { defaultCurrency } from './salary';

// The job list's URL, read once for the list page (app/page.tsx) and for the job page's Previous / Next, which walks
// the same list the user came from (its `?from=`). Reads config.json (country labels, currency) on every call.

export type ListParams = Record<string, string | string[] | undefined>;

/** A list URL's query (`?status=new&days=3`) as page search params, first value of each key. */
export function paramsOf(search: string): ListParams {
  const sp: ListParams = {};
  for (const [k, v] of new URLSearchParams(search)) sp[k] ??= v;
  return sp;
}

/** Everything the list page reads from its URL: the tab, the filters, the page, the DB filter and the links. */
export function listView(sp: ListParams) {
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
  const page = Math.max(1, Math.floor(Number(one('page'))) || 1);
  const size = pageSize(one('size'));
  const everyTab = Boolean(q) && !followUp && !onlyTab;
  // "Posted within" narrows the Matching tab only: in the pipeline tabs (Applied, Interview, ...) and a search across
  // every tab, a job's age is not a reason to hide it.
  const postedFilter = status === 'new' && !followUp && !everyTab ? days : undefined;
  const filter: JobFilter = { status, country, min, q, days: postedFilter, sort, followUp, visaOnly, everyTab, ...salary.filter };
  // The same tab and search without the narrowing filters, and the names of those that are on (the empty list says
  // how many jobs they hide).
  const unfiltered: JobFilter = { status, q, sort, followUp, everyTab };
  const active = [
    postedFilter && 'date',
    min && 'score',
    country && 'country',
    (salary.filter.minSalary || salary.filter.salaryOnly) && 'salary',
    visaOnly && 'visa',
  ].filter((s): s is string => Boolean(s));

  // Tabs and filters start again at page 1; the page links keep everything else. Every link carries `days` (even the
  // default), so it has a remembered filter of its own and proxy.ts has no reason to redirect it.
  // While searching, a tab link narrows the search to that tab (in=tab); page links keep the current scope.
  const tabParams = (s: string, view?: 'followup', toPage = 1, scope: 'tab' | 'keep' = 'tab') =>
    new URLSearchParams({
      ...(view ? { view } : { status: s }),
      ...(country && { country }),
      ...(min && { min: String(min) }),
      ...(q && { q }),
      ...(q && (scope === 'tab' || onlyTab) && { in: 'tab' }),
      days: String(days ?? 0),
      ...(sort === 'newest' && { sort }),
      ...(visaOnly && { visa: '1' }),
      ...salary.query,
      ...(size !== PAGE_SIZE && { size: String(size) }),
      ...(toPage > 1 && { page: String(toPage) }),
    });
  const tabHref = (s: string, view?: 'followup', toPage = 1, scope: 'tab' | 'keep' = 'tab') => `/?${tabParams(s, view, toPage, scope)}`;
  const pageHref = (n: number) => tabHref(status, followUp ? 'followup' : undefined, n, 'keep');

  return {
    followUp,
    status,
    labels,
    country,
    min,
    q,
    onlyTab,
    days,
    sort,
    visaOnly,
    salary,
    page,
    size,
    everyTab,
    filter,
    unfiltered,
    active,
    tabParams,
    tabHref,
    pageHref,
  };
}
