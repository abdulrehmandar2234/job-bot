import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as bot from '../../../src/followup';
import { followUpCount, listJobs } from '@/lib/db';
import { daysWaiting, FOLLOW_UP_DAYS, FOLLOW_UP_DUE_SQL, isDue, MAX_FOLLOW_UPS } from '@/lib/followup';
import { cleanupDb, closeDb, dateDaysAgo, ensureSchema, insertJob, ours, PREFIX } from '../helpers/db';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('follow-up rule', () => {
  it('matches the bot (src/followup.ts)', () => {
    expect([FOLLOW_UP_DAYS, MAX_FOLLOW_UPS, FOLLOW_UP_DUE_SQL]).toEqual([bot.FOLLOW_UP_DAYS, bot.MAX_FOLLOW_UPS, bot.FOLLOW_UP_DUE_SQL]);
  });

  it('isDue: applied, waiting long enough since applying or the last follow-up, below the maximum', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    const at = (iso: string) => new Date(iso);
    const job = { status: 'applied' as const, applied_at: at('2026-10-20T12:00:00Z'), follow_ups: 0, followed_up_at: null };
    expect(daysWaiting(job, now)).toBe(9);
    expect(isDue(job, now)).toBe(true);
    expect(isDue({ ...job, applied_at: at('2026-10-23T12:00:00Z') }, now)).toBe(false); // 6 days
    expect(isDue({ ...job, applied_at: at('2026-10-22T12:00:00Z') }, now)).toBe(true); // exactly 7
    expect(isDue({ ...job, follow_ups: 1, followed_up_at: at('2026-10-27T12:00:00Z') }, now)).toBe(false);
    expect(isDue({ ...job, follow_ups: MAX_FOLLOW_UPS, followed_up_at: at('2026-10-01T12:00:00Z') }, now)).toBe(false);
    expect(isDue({ ...job, status: 'interview' }, now)).toBe(false);
    expect(isDue({ ...job, applied_at: null }, now)).toBe(false);
    expect(isDue({ status: 'applied', applied_at: job.applied_at }, now)).toBe(true); // list rows without the counters
  });
});

describe('listJobs({ followUp }) and followUpCount', () => {
  it('lists only due applied jobs, the longest wait first, and counts them', async () => {
    const before = await followUpCount();
    await insertJob({ id: 'fu-a', status: 'applied', applied_at: dateDaysAgo(8) });
    await insertJob({ id: 'fu-b', status: 'applied', applied_at: dateDaysAgo(20) });
    await insertJob({ id: 'fu-recent', status: 'applied', applied_at: dateDaysAgo(2) });
    await insertJob({ id: 'fu-max', status: 'applied', applied_at: dateDaysAgo(30), follow_ups: 2, followed_up_at: dateDaysAgo(10) });
    await insertJob({ id: 'fu-interview', status: 'interview', applied_at: dateDaysAgo(30) });
    const rows = await listJobs({ status: 'applied', followUp: true });
    expect(ours(rows)).toEqual([PREFIX + 'fu-b', PREFIX + 'fu-a']);
    expect(rows.find((r) => r.id === PREFIX + 'fu-a')).toMatchObject({ follow_ups: 0, followed_up_at: null });
    expect(await followUpCount()).toBe(before + 2);
    // Without the flag the Applied tab still lists every applied job.
    expect(ours(await listJobs({ status: 'applied' })).sort()).toEqual([
      PREFIX + 'fu-a',
      PREFIX + 'fu-b',
      PREFIX + 'fu-max',
      PREFIX + 'fu-recent',
    ]);
  });
});
