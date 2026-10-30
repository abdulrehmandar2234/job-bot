'use client';

import { useEffect } from 'react';

/** What an error boundary received: an Error from a Server Component (generic message + digest), or anything thrown. */
export function errorText(error: unknown): { message: string; digest?: string } {
  if (error instanceof Error) {
    const digest = (error as Error & { digest?: string }).digest;
    return { message: error.message || 'Unknown error', ...(digest && { digest }) };
  }
  return { message: String(error) };
}

/** The body of an error.tsx boundary: what failed and a "Try again" that re-fetches and re-renders the segment. */
export function ErrorPanel({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  const { message, digest } = errorText(error);
  return (
    <section
      role="alert"
      className="mt-4 space-y-3 rounded-xl border border-rose-300 bg-rose-50 p-4 text-sm dark:border-rose-800 dark:bg-rose-950/30"
    >
      <h2 className="font-medium text-rose-800 dark:text-rose-300">Something went wrong</h2>
      <p className="whitespace-pre-line text-rose-700 dark:text-rose-400">{message}</p>
      {digest && <p className="text-xs text-zinc-500">Error id: {digest} (see the dashboard's server log)</p>}
      <button type="button" className="btn" onClick={() => retry()}>
        Try again
      </button>
    </section>
  );
}
