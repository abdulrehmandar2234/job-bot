// The job list's filters stay as they were set until they are changed again: a refresh, another tab, a job page and
// back, or opening the dashboard fresh all show the same filters. proxy.ts keeps the last ones in a cookie and puts
// them back into a list URL that has none of its own.
// The search text, the tab and the page are not remembered: they belong to one visit.

/** The cookie that holds the last filters, as a query string. */
export const FILTER_COOKIE = 'job-bot-filters';

/** The filter form's fields that are remembered (see the form in app/page.tsx and components/salary.tsx). */
export const REMEMBERED = ['country', 'min', 'days', 'sort', 'size', 'visa', 'sal', 'cur', 'per', 'salonly'] as const;

/** "Posted within" when the URL does not say: the last 24 hours. `days=0` means any time. */
export const DEFAULT_DAYS = 1;

/** The "Posted within" days from the URL value: DEFAULT_DAYS when absent, undefined (any time) for 0 or empty. */
export function postedDays(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The remembered filters in a list URL's query, empty values included (a filter set back to "any"), or null if none. */
export function filtersOf(params: URLSearchParams): string | null {
  const kept = new URLSearchParams();
  for (const [k, v] of params) if ((REMEMBERED as readonly string[]).includes(k)) kept.append(k, v);
  return kept.size ? kept.toString() : null;
}

/**
 * The list URL with the saved filters added, when it has no filters of its own and some were saved; else null (the
 * URL stays as it is). Everything else in it (tab, search, page) is kept.
 */
export function withSavedFilters(url: URL, saved: string | undefined): URL | null {
  if (!saved || filtersOf(url.searchParams)) return null;
  const add = filtersOf(new URLSearchParams(saved));
  if (!add) return null;
  const next = new URL(url);
  for (const [k, v] of new URLSearchParams(add)) next.searchParams.append(k, v);
  return next;
}
