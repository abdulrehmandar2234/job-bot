import Link from 'next/link';
import { jobNeighbours } from '@/lib/db';
import { listFrom } from '@/lib/filter-memory';
import { listView, paramsOf } from '@/lib/job-list';
import { JobKeys } from './job-keys';

/** A job page link that keeps the list it was opened from (`?from=`). */
export const jobPageHref = (id: string, from: string | null) =>
  `/jobs/${encodeURIComponent(id)}${from ? `?${new URLSearchParams({ from })}` : ''}`;

const muted = 'text-zinc-400 dark:text-zinc-600';

/**
 * Where the job page's navigation leads: back to the exact list the job was opened from (tab, filters, search, page;
 * `from`, checked by listFrom so it never leads off the dashboard), and the jobs before and after it in that list.
 * Without a usable `from`, back is `/`, where proxy.ts restores the saved filters, and there is no Previous / Next.
 */
export async function jobNav(id: string, raw: unknown): Promise<JobNavLinks> {
  const from = listFrom(Array.isArray(raw) ? raw[0] : raw);
  if (!from) return { from: null, prev: null, next: null };
  const { prev, next } = await jobNeighbours(listView(paramsOf(from.slice(1))).filter, id);
  return { from, prev: prev && jobPageHref(prev, from), next: next && jobPageHref(next, from) };
}

export type JobNavLinks = { from: string | null; prev: string | null; next: string | null };

/** The top of the job page: "← All jobs", Previous / Next within the list it came from (jobNav), and the keys. */
export function JobNav({ from, prev: prevHref, next: nextHref }: JobNavLinks) {
  return (
    <div className="space-y-1">
      <nav aria-label="Job list" className="flex flex-wrap items-center justify-between gap-2 text-sm text-zinc-500">
        <Link href={from ?? '/'} className="hover:underline">
          ← All jobs
        </Link>
        {from && (
          <span className="flex gap-3">
            {prevHref ? (
              <Link href={prevHref} aria-keyshortcuts="k" className="hover:underline">
                ← Previous
              </Link>
            ) : (
              <span className={muted}>← Previous</span>
            )}
            {nextHref ? (
              <Link href={nextHref} aria-keyshortcuts="j" className="hover:underline">
                Next →
              </Link>
            ) : (
              <span className={muted}>Next →</span>
            )}
          </span>
        )}
      </nav>
      <JobKeys prev={prevHref} next={nextHref} back={from ?? '/'} />
    </div>
  );
}
