import Link from 'next/link';
import { Suspense } from 'react';
import { DIMENSIONS, funnel, median, MIN_N, recentFetchRuns, responseDays, responseRates, weeklyActivity } from '@/lib/analytics';
import { FetchRuns, FunnelChart, RateTable, Section, WeeklyBars } from '@/components/analytics';
import { SkipPatterns } from '@/components/skip-patterns';
import { readConfig } from '@/lib/settings';
import { skipInsights } from '@/lib/skip-insights';

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All jobs
      </Link>
      <h1 className="mt-2 mb-5 text-2xl font-semibold tracking-tight">Analytics</h1>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading…</p>}>
        <Analytics />
      </Suspense>
    </main>
  );
}

async function Analytics() {
  const roleExclude = readConfig().data?.roleExclude;
  const [f, rates, weeks, days, runs, skips] = await Promise.all([
    funnel(),
    Promise.all(DIMENSIONS.map(responseRates)),
    weeklyActivity(),
    responseDays(),
    recentFetchRuns(),
    skipInsights(typeof roleExclude === 'string' ? roleExclude : null),
  ]);
  const med = median(days.map((d) => d.days));

  return (
    <div className="space-y-5">
      {f.applied === 0 ? (
        <section className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          <p className="font-medium text-zinc-900 dark:text-zinc-100">No applications yet</p>
          <p>Mark jobs as Applied on the job list, and the funnel and response rates show up here.</p>
        </section>
      ) : (
        <>
          <div className="grid gap-5 md:grid-cols-[3fr_2fr]">
            <Section title="Funnel" sub="Furthest stage each job reached, from its status history">
              <FunnelChart f={f} />
            </Section>
            <Section title="Time to response" sub="Median days from applying to the first interview or rejection">
              {med == null ? (
                <p className="text-sm text-zinc-500">No replies yet.</p>
              ) : (
                <p>
                  <span className="text-3xl font-semibold tabular-nums">{med.toFixed(1)}</span> days
                  <span className="block text-xs text-zinc-500">
                    from {days.length} repl{days.length === 1 ? 'y' : 'ies'}
                  </span>
                </p>
              )}
            </Section>
          </div>
          <Section
            title="Response rate"
            sub={`Applications that led to an interview or offer. Groups with fewer than ${MIN_N} applications are greyed out.`}
          >
            <div className="grid gap-5 sm:grid-cols-2">
              {DIMENSIONS.map((d, i) => (
                <RateTable key={d} dim={d} rows={rates[i]} />
              ))}
            </div>
          </Section>
        </>
      )}
      <Section title="Activity" sub="Last 12 weeks">
        <WeeklyBars weeks={weeks} />
      </Section>
      <Section id="skips" title="Skip patterns" sub="Why you skip jobs, and what roleExclude could filter out for you">
        <SkipPatterns insights={skips} />
      </Section>
      <Section id="fetch" title="Fetch health" sub="Last 7 fetch runs">
        <FetchRuns runs={runs} />
      </Section>
    </div>
  );
}
