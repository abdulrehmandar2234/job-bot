'use client'; // Error boundaries must be Client Components.

import Link from 'next/link';
import { ErrorPanel } from '@/components/error-panel';

// A failure on a job's page (loading it, or one of its actions) keeps the way back to the list.
export default function JobError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All jobs
      </Link>
      <ErrorPanel error={error} retry={retry} />
    </main>
  );
}
