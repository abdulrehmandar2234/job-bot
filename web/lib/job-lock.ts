import type { PoolClient } from 'pg';
import { ActionError } from './action-state';
import { pool, type JobEvent, type Status } from './db';

// The job checks every job-page server action starts with. Server actions are reachable by POST, so the id is
// validated here, and a job that is gone (dedupe can delete one mid-click) answers 'Unknown job' as an ActionError,
// which the action's form shows next to the button instead of crashing the page.

/** The job id from a form field, or ActionError('Missing job id'). */
export function jobIdOf(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new ActionError('Missing job id');
  return v;
}

/**
 * For actions that only read the job or queue work for it: the id when the job exists, else ActionError. Work that
 * changes the job's row under a rule (its status) locks it with withJobLock instead, so the check and the change
 * cannot be split by another tab or the bot.
 */
export async function assertJob(v: unknown): Promise<string> {
  const id = jobIdOf(v);
  const { rowCount } = await pool.query('SELECT 1 FROM jobs WHERE id = $1', [id]);
  if (!rowCount) throw new ActionError('Unknown job');
  return id;
}

/** What a locked job's caller may decide from. */
export type LockedJob = { id: string; status: Status; applied_at: Date | null };

/** Locks the job's row (SELECT … FOR UPDATE) inside the caller's transaction, or ActionError('Unknown job'). */
export async function lockJob(client: PoolClient, id: string): Promise<LockedJob> {
  const { rows } = await client.query<LockedJob>('SELECT id, status, applied_at FROM jobs WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw new ActionError('Unknown job');
  return rows[0];
}

/** Runs `work` in one transaction with the job's row locked (lockJob); rolls back on any error. */
export async function withJobLock<T>(id: string, work: (client: PoolClient, job: LockedJob) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client, await lockJob(client, id));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {}); // a dropped connection must not hide the real error
    throw e;
  } finally {
    client.release();
  }
}

/** The note on the history row that an Undo writes. */
export const UNDO_NOTE = 'undo';

/** A history row that changed the status (follow-up entries keep it: applied → applied). */
export const isStatusChange = (e: Pick<JobEvent, 'from_status' | 'to_status'>) => e.from_status !== null && e.from_status !== e.to_status;

/**
 * Whether Undo can move the job back along `last`, its latest status change (isStatusChange): only while the job is
 * still where that change put it, and not an Undo itself (one step back, no redo chains).
 */
export function canUndo(last: Pick<JobEvent, 'from_status' | 'to_status' | 'note'> | undefined, status: string): boolean {
  return !!last && isStatusChange(last) && last.note !== UNDO_NOTE && last.to_status === status;
}
