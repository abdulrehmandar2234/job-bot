import type { Contact, Job } from './types.ts';

// Follow-up reminders: an `applied` job with no news for FOLLOW_UP_DAYS needs a short follow-up message, which the
// bot drafts and the user sends. After MAX_FOLLOW_UPS sent follow-ups the job is left alone.
// Pure (type imports only), so the dashboard imports the same rule. The queries are in db.ts (dueFollowUps,
// markFollowedUp).

export const FOLLOW_UP_DAYS = 7;
export const MAX_FOLLOW_UPS = 2;

/** SQL condition: the job is due a follow-up. Counts from the last follow-up, or from applying. */
export const FOLLOW_UP_DUE_SQL = `(status = 'applied' AND follow_ups < ${MAX_FOLLOW_UPS}
  AND coalesce(followed_up_at, applied_at) <= now() - interval '${FOLLOW_UP_DAYS} days')`;

/** What the rule needs from a job. List rows may lack the counters: missing means no follow-up sent yet. */
export type FollowUpInfo = Pick<Job, 'status' | 'applied_at'> & Partial<Pick<Job, 'follow_ups' | 'followed_up_at'>>;

/** Whole days since the user applied (or last followed up), or null without a date. */
export function daysWaiting(job: Pick<FollowUpInfo, 'applied_at' | 'followed_up_at'>, now = new Date()): number | null {
  const since = job.followed_up_at ?? job.applied_at;
  return since ? Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000) : null;
}

/** The same rule as FOLLOW_UP_DUE_SQL, for a job already loaded. */
export function isDue(job: FollowUpInfo, now = new Date()): boolean {
  const days = daysWaiting(job, now);
  return job.status === 'applied' && (job.follow_ups ?? 0) < MAX_FOLLOW_UPS && days !== null && days >= FOLLOW_UP_DAYS;
}

/** The person to address: a recruiter first, then a hiring manager. Referrals are asked separately. */
export function addressee(contacts: Pick<Contact, 'name' | 'role'>[]): string | null {
  const c = contacts.find((x) => x.role === 'recruiter') ?? contacts.find((x) => x.role === 'hiring manager');
  return c?.name ?? null;
}

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'recently');

/** A plain follow-up without AI (AI off, --template, or the CLI failing), signed by `sender` (the profile's name). */
export function templateFollowUp(
  job: Pick<Job, 'company' | 'title' | 'applied_at' | 'follow_ups'>,
  name: string | null,
  sender: string | null,
): string {
  const again = job.follow_ups > 0 ? ' once more' : '';
  return [
    `Dear ${name ?? `${job.company} Hiring Team`},`,
    '',
    `I applied for the ${job.title} position on ${fmt(job.applied_at)} and wanted to follow up${again} on my application. ` +
      `I am still very interested in the role and would welcome the chance to discuss how my experience fits your team.`,
    '',
    'Please let me know if you need anything else from me.',
    '',
    'Best regards,',
    ...[sender].filter(Boolean),
    '',
  ].join('\n');
}
