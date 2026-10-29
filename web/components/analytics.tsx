import Link from 'next/link';
import type { ReactNode } from 'react';
import { lastFetchErrorCount, rate, type FetchRunRow, type Funnel, type RateRow, type WeekRow } from '@/lib/analytics';
import { COUNTRIES, fmtDate, STATUS_LABEL } from '@/components/ui';

export const pctText = (r: number | null) => (r == null ? '—' : `${Math.round(r * 100)}%`);

/** A plain horizontal bar; the number next to it carries the meaning, so the bar itself is hidden from screen readers. */
function Bar({ value, max, tone = 'bg-sky-500' }: { value: number; max: number; tone?: string }) {
  const w = max > 0 ? Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <div aria-hidden className="h-2.5 w-full rounded-full bg-zinc-100 dark:bg-zinc-800">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export function Section({ id, title, sub, children }: { id?: string; title: string; sub?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={id && `${id}-title`} className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div>
        <h2 id={id && `${id}-title`} className="font-semibold">{title}</h2>
        {sub && <p className="text-xs text-zinc-500">{sub}</p>}
      </div>
      {children}
    </section>
  );
}

const STAGES = ['matched', 'prepared', 'applied', 'interview', 'offer'] as const;

/** matched → prepared → applied → interview → offer, each with its conversion from the step before. */
export function FunnelChart({ f }: { f: Funnel }) {
  return (
    <div className="space-y-3">
      <ol className="space-y-2">
        {STAGES.map((s, i) => (
          <li key={s} className="grid grid-cols-[6rem_1fr_auto] items-center gap-3 text-sm">
            <span>{s === 'matched' ? 'Matched' : STATUS_LABEL[s]}</span>
            <Bar value={f[s]} max={f.matched} tone="bg-emerald-500" />
            <span className="w-28 text-right tabular-nums">
              <b>{f[s]}</b>
              {i > 0 && <span className="text-zinc-500"> · {pctText(rate(f[s], f[STAGES[i - 1]]))}</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-sm text-zinc-500">
        Rejected <b className="text-zinc-900 dark:text-zinc-100">{f.rejected}</b> · Skipped <b className="text-zinc-900 dark:text-zinc-100">{f.skipped}</b>
        {' '}· percentages are the share of the step before.
      </p>
    </div>
  );
}

const DIM_TITLE: Record<string, string> = { source: 'Source', country: 'Country', cv_version: 'CV version', ai_verdict: 'AI verdict' };
const EMPTY_KEY: Record<string, string> = { source: 'unknown', country: 'no country', cv_version: 'no CV chosen', ai_verdict: 'not AI-reviewed' };

/** Response rate per group; groups below MIN_N applications are muted and say so. */
export function RateTable({ dim, rows }: { dim: string; rows: RateRow[] }) {
  const label = (k: string | null) => (k == null ? EMPTY_KEY[dim] : dim === 'country' ? COUNTRIES[k] ?? k : k);
  return (
    <table className="w-full text-sm">
      <caption className="mb-1 text-left text-xs font-medium uppercase tracking-wide text-zinc-500">{DIM_TITLE[dim]}</caption>
      <tbody>
        {rows.length === 0 && <tr><td className="text-zinc-500">No data</td></tr>}
        {rows.map((r) => (
          <tr key={r.key ?? ''} data-small={r.small || undefined}
            title={r.small ? 'Fewer than 5 applications: too few to judge' : undefined}
            className={r.small ? 'text-zinc-400 dark:text-zinc-500' : ''}>
            <td className="w-2/5 truncate py-1 pr-2">{label(r.key)}</td>
            <td className="py-1 pr-2"><Bar value={r.responded} max={r.n} tone={r.small ? 'bg-zinc-400 dark:bg-zinc-600' : 'bg-sky-500'} /></td>
            <td className="whitespace-nowrap py-1 text-right tabular-nums">
              {pctText(r.rate)} <span className="text-xs text-zinc-500">({r.responded}/{r.n})</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Applications and new matches per week, as a table of bars (newest week last). */
export function WeeklyBars({ weeks }: { weeks: WeekRow[] }) {
  const maxApplied = Math.max(0, ...weeks.map((w) => w.applied));
  const maxMatches = Math.max(0, ...weeks.map((w) => w.matches));
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Jobs applied and new matches per week</caption>
      <thead>
        <tr className="text-left text-xs text-zinc-500">
          <th scope="col" className="w-20 pb-1 font-normal">Week of</th>
          <th scope="col" className="pb-1 pr-4 font-normal"><span className="mr-1 inline-block size-2 rounded-full bg-emerald-500" />Applied</th>
          <th scope="col" className="pb-1 font-normal"><span className="mr-1 inline-block size-2 rounded-full bg-sky-500" />New matches</th>
        </tr>
      </thead>
      <tbody>
        {weeks.map((w) => (
          <tr key={new Date(w.week).toISOString()}>
            <th scope="row" className="py-0.5 text-left font-normal text-zinc-500">{fmtDate(w.week)}</th>
            <td className="py-0.5 pr-4">
              <div className="flex items-center gap-2"><Bar value={w.applied} max={maxApplied} tone="bg-emerald-500" />
                <span className="w-8 text-right tabular-nums">{w.applied}</span></div>
            </td>
            <td className="py-0.5">
              <div className="flex items-center gap-2"><Bar value={w.matches} max={maxMatches} />
                <span className="w-8 text-right tabular-nums">{w.matches}</span></div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const fmtTime = (d: Date) => new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The last fetch runs; a run with errors expands to list which source failed and why. */
export function FetchRuns({ runs }: { runs: FetchRunRow[] }) {
  if (!runs.length) return <p className="text-sm text-zinc-500">No fetch has run yet.</p>;
  return (
    <ul className="divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
      {runs.map((r) => (
        <li key={r.id} className="py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <span>{fmtTime(r.started_at)}{!r.finished_at && <span className="text-amber-700 dark:text-amber-400"> · did not finish</span>}</span>
            <span className="tabular-nums text-zinc-600 dark:text-zinc-400">
              {r.checked} checked · {r.inserted} inserted · {r.new_matches} new matches ·{' '}
              <span className={r.errors.length ? 'font-medium text-rose-700 dark:text-rose-400' : ''}>
                {r.errors.length} error{r.errors.length === 1 ? '' : 's'}
              </span>
            </span>
          </div>
          {r.errors.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-zinc-500">Show errors</summary>
              <ul className="mt-1 space-y-0.5 text-xs">
                {r.errors.map((e, i) => (
                  <li key={i}><b>{e.company}</b>: <span className="text-rose-700 dark:text-rose-400">{e.error}</span></li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Header warning on the job list when the latest fetch had failing sources. */
export async function FetchWarning() {
  const n = await lastFetchErrorCount();
  if (!n) return null;
  return (
    <Link href="/analytics#fetch"
      className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-sm text-amber-800 hover:underline dark:bg-amber-950 dark:text-amber-300">
      ⚠ Last fetch: {n} error{n === 1 ? '' : 's'}
    </Link>
  );
}
