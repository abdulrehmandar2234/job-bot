import Link from 'next/link';

/** Shown where an AI-only button would be while config.json `ai.enabled` is false (lib/settings.ts aiEnabled). */
export function AiOffNote({ what }: { what: string }) {
  return (
    <p role="note" className="text-xs text-zinc-500">
      AI is off, so {what} is not available.{' '}
      <Link href="/settings" className="underline">
        Turn it on in Settings
      </Link>
      .
    </p>
  );
}
