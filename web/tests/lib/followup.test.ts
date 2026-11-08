import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { followUpCount, listJobs } from '@/lib/db';
import { cleanupDb, closeDb, dateDaysAgo, ensureSchema, insertJob, ours, PREFIX } from '../helpers/db';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

// The rule itself (isDue, daysWaiting) is the bot's, tested in tests/followup.test.ts; these check the dashboard's queries.
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
