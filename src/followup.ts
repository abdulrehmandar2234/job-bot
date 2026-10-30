import { pool } from './db.ts';
import { loadProfile } from './profile.ts';
import type { Contact, Job } from './types.ts';

// Follow-up reminders: an `applied` job with no news for FOLLOW_UP_DAYS needs a short follow-up message, which the
// bot drafts and the user sends. After MAX_FOLLOW_UPS sent follow-ups the job is left alone.
// The dashboard uses the same rule (web/lib/followup.ts, checked by web/tests/lib/followup.test.ts).

export const FOLLOW_UP_DAYS = 7;
export const MAX_FOLLOW_UPS = 2;

/** SQL condition: the job is due a follow-up. Counts from the last follow-up, or from applying. */
export const FOLLOW_UP_DUE_SQL = `(status = 'applied' AND follow_ups < ${MAX_FOLLOW_UPS}
  AND coalesce(followed_up_at, applied_at) <= now() - interval '${FOLLOW_UP_DAYS} days')`;

/** Whole days since the user applied (or last followed up), or null without a date. */
export function daysWaiting(job: Pick<Job, 'applied_at' | 'followed_up_at'>, now = new Date()): number | null {
  const since = job.followed_up_at ?? job.applied_at;
  return since ? Math.floor((now.getTime() - new Date(since).getTime()) / 86_400_000) : null;
}

/** Applied jobs due a follow-up, the longest wait first. */
export async function dueFollowUps(): Promise<Job[]> {
  const { rows } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE duplicate_of IS NULL AND ${FOLLOW_UP_DUE_SQL} ORDER BY coalesce(followed_up_at, applied_at)`,
  );
  return rows;
}

/** The person to address: a recruiter first, then a hiring manager. Referrals are asked separately. */
export function addressee(contacts: Pick<Contact, 'name' | 'role'>[]): string | null {
  const c = contacts.find((x) => x.role === 'recruiter') ?? contacts.find((x) => x.role === 'hiring manager');
  return c?.name ?? null;
}

const fmt = (d: Date | null) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : 'recently');

/** A plain follow-up without AI (AI off, --template, or the CLI failing). */
export function templateFollowUp(job: Pick<Job, 'company' | 'title' | 'applied_at' | 'follow_ups'>, name: string | null): string {
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
    ...[loadProfile().fullName].filter(Boolean),
    '',
  ].join('\n');
}

/** Records that the user sent a follow-up: counts it and logs it in the job's history. Returns the new count. */
export async function markFollowedUp(id: string): Promise<number | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ follow_ups: number; status: string }>(
      `UPDATE jobs SET follow_ups = follow_ups + 1, followed_up_at = now() WHERE id = $1 RETURNING follow_ups, status`,
      [id],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('INSERT INTO job_events (job_id, from_status, to_status, note) VALUES ($1, $2, $2, $3)', [
      id,
      rows[0].status,
      `Follow-up ${rows[0].follow_ups} sent`,
    ]);
    await client.query('COMMIT');
    return rows[0].follow_ups;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
