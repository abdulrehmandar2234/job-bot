import type { Job } from '../../src/types';

// Follow-up reminders, same rule as job-bot/src/followup.ts (web/tests/lib/followup.test.ts checks they match):
// an `applied` job with no news for FOLLOW_UP_DAYS is due a follow-up, at most MAX_FOLLOW_UPS times.

export const FOLLOW_UP_DAYS = 7;
export const MAX_FOLLOW_UPS = 2;

/** SQL condition: the job is due a follow-up. Counts from the last follow-up, or from applying. */
export const FOLLOW_UP_DUE_SQL = `(status = 'applied' AND follow_ups < ${MAX_FOLLOW_UPS}
  AND coalesce(followed_up_at, applied_at) <= now() - interval '${FOLLOW_UP_DAYS} days')`;

export type FollowUpInfo = Pick<Job, 'status' | 'applied_at'> & Partial<Pick<Job, 'follow_ups' | 'followed_up_at'>>;

/** Whole days since the user applied (or last followed up), or null without a date. */
export function daysWaiting(job: FollowUpInfo, now = new Date()): number | null {
  const since = job.followed_up_at ?? job.applied_at;
  return since ? Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000) : null;
}

/** The same rule as FOLLOW_UP_DUE_SQL, for a job already loaded. */
export function isDue(job: FollowUpInfo, now = new Date()): boolean {
  const days = daysWaiting(job, now);
  return job.status === 'applied' && (job.follow_ups ?? 0) < MAX_FOLLOW_UPS && days !== null && days >= FOLLOW_UP_DAYS;
}
