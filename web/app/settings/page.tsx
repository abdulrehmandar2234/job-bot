import Link from 'next/link';
import { Suspense } from 'react';
import { Settings } from '@/components/settings-page';

export default function Page() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <Link href="/" className="text-sm text-zinc-500 hover:underline">
        ← All jobs
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Settings</h1>
      <Suspense fallback={<p className="mt-4 text-sm text-zinc-500">Loading…</p>}>
        <Settings />
      </Suspense>
    </main>
  );
}
