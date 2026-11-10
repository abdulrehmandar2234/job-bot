import { DatabaseError } from 'pg';
import { BotStartError } from './bot';
import { CvBusyError } from './tasks';
import type { TextFormState } from './written-text';

// One-click server actions (Skip, Prepare CV, Dismiss, …) answer with a TextFormState instead of throwing:
// a thrown server action replaces the whole page with app/error.tsx, losing the user's place. Expected
// failures — a job deleted by dedupe mid-click, a Postgres hiccup, a failed bot run — come back as
// { ok: false, message } and are shown next to the button (components/action-form.tsx). Anything else
// (a programmer error) still throws.

/** An expected, user-facing failure in a server action. Its message is shown next to the button. */
export class ActionError extends Error {}

/** System error codes that mean Postgres cannot be reached over the network (connect() rejects with one). */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'EAI_AGAIN']);
/** pg's own errors for a lost or never-made connection: plain Errors with no code. */
const UNREACHABLE_PG =
  /^(Connection terminated unexpectedly|Connection terminated due to connection timeout|timeout exceeded when trying to connect)$/;

function unreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const code = (e as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && UNREACHABLE_CODES.has(code)) return true;
  if (e instanceof AggregateError) return e.errors.some(unreachable); // one refusal per address (::1 and 127.0.0.1)
  return UNREACHABLE_PG.test(e.message);
}

/** The message for an expected failure, or null when the error is a programmer error and should throw. */
export function expectedFailure(e: unknown): string | null {
  if (e instanceof ActionError || e instanceof CvBusyError || e instanceof BotStartError) return e.message;
  // A query Postgres refused (bad value, constraint, …).
  if (e instanceof DatabaseError) return `Database error: ${e.message}. Try again.`;
  // Only network failures mean Postgres is down: a file system error (EACCES from mkdir, …) is not the database.
  if (unreachable(e)) return 'The database is not reachable right now. Try again in a moment.';
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

/** Node's notice when the bot's .env is missing: printed before the bot's own output, never the reason it failed. */
const DOTENV_NOTICE = /\.env not found/i;

/** A short, human line for a failed `runBot` call (non-zero exit, timeout, or spawn failure). */
export function botFailure(e: unknown): string {
  const err = e as { killed?: boolean; stderr?: unknown } | null;
  if (err && typeof err === 'object' && err.killed) return 'The bot took too long and was stopped. Try again.';
  const lines = (typeof err?.stderr === 'string' ? err.stderr : '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !DOTENV_NOTICE.test(l));
  // Node prints "Error: <message>" plus a stack for a thrown error; otherwise the bot's own last line says why.
  const thrown = lines.map((l) => /^[A-Za-z]*Error: (.+)$/.exec(l)?.[1]).find(Boolean);
  const reason = thrown ?? lines.filter((l) => !l.startsWith('at ')).at(-1);
  return reason ? `The bot failed: ${reason}` : 'The bot failed to run. Try again (its output is in the dashboard terminal).';
}
