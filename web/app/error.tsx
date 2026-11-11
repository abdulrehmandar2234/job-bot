'use client'; // Error boundaries must be Client Components.

import Link from 'next/link';
import { ErrorPanel } from '@/components/error-panel';

// Catches what a page under app/ throws (a failed action, an unreachable database) so the dashboard's header and
// links stay usable instead of the whole page being replaced. The root layout itself is not covered.
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link href="/" className="hover:underline">
            Talaash
          </Link>
        </h1>
        <nav aria-label="Dashboard" className="flex flex-wrap gap-2">
          <Link href="/" className="btn">
            All jobs
          </Link>
          <Link href="/analytics" className="btn">
            Analytics
          </Link>
          <Link href="/settings" className="btn">
            Settings
          </Link>
        </nav>
      </header>
      <ErrorPanel error={error} retry={retry} />
    </main>
  );
}
