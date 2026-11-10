import Link from 'next/link';

/**
 * Any unknown page, and a job that is not in the database (any more): a stale link from the extension, a bookmark,
 * or a duplicate merged into another posting. Leads back to the list, where proxy.ts restores the saved filters.
 */
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-xl space-y-3 px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">Not found</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        This page or job is not in the dashboard. The link may be old, or the job was merged into another posting of the same job.
      </p>
      <Link href="/" className="btn">
        ← Back to the job list
      </Link>
    </main>
  );
}
