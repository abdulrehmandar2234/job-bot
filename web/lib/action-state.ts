import { DatabaseError } from 'pg';
import { CvBusyError } from './tasks';
import type { TextFormState } from './written-text';

// One-click server actions (Skip, Prepare CV, Dismiss, …) answer with a TextFormState instead of throwing:
// a thrown server action replaces the whole page with app/error.tsx, losing the user's place. Expected
// failures — a job deleted by dedupe mid-click, a Postgres hiccup, a failed bot run — come back as
// { ok: false, message } and are shown next to the button (components/action-form.tsx). Anything else
// (a programmer error) still throws.

/** An expected, user-facing failure in a server action. Its message is shown next to the button. */
export class ActionError extends Error {}

/** The message for an expected failure, or null when the error is a programmer error and should throw. */
export function expectedFailure(e: unknown): string | null {
  if (e instanceof ActionError || e instanceof CvBusyError) return e.message;
  // A query Postgres refused (bad value, constraint, …).
  if (e instanceof DatabaseError) return `Database error: ${e.message}. Try again.`;
  // Postgres not reachable: connect() rejects with a system error (ECONNREFUSED…) or an AggregateError.
  const sys = e as NodeJS.ErrnoException;
  if (e instanceof AggregateError || (e instanceof Error && typeof sys.code === 'string' && typeof sys.syscall === 'string'))
    return 'The database is not reachable right now. Try again in a moment.';
  return null;
}

/**
 * Runs a one-click action body and turns expected failures into a form state for the button's form.
 * The body returns its own state (a refusal) or nothing; success with nothing to say is null.
 */
export async function guarded(work: (() => Promise<TextFormState | undefined>) | (() => Promise<void>)): Promise<TextFormState> {
  try {
    return (await work()) ?? null;
  } catch (e) {
    const message = expectedFailure(e);
    if (message === null) throw e;
    return { ok: false, message };
  }
}

/** A short, human line for a failed `runBot` call (non-zero exit, timeout, or spawn failure). */
export function botFailure(e: unknown): string {
  const err = e as { killed?: boolean; stderr?: unknown } | null;
  if (err && typeof err === 'object' && err.killed) return 'The bot took too long and was stopped. Try again.';
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
  // Node prints "Error: <message>" (plus a stack) for a thrown error; a clean one-line message is used as is.
  const reason = /^[A-Za-z]*Error: (.+)$/m.exec(stderr)?.[1] ?? (stderr && !stderr.includes('\n') ? stderr : null);
  return reason ? `The bot failed: ${reason}` : 'The bot failed to run. Try again (its output is in the dashboard terminal).';
}
