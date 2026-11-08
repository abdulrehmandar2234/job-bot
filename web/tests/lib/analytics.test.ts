import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '@/lib/db';
import {
  funnel,
  lastFetchErrorCount,
  median,
  MIN_N,
  rate,
  recentFetchRuns,
  responseDays,
  responseRates,
  weeklyActivity,
  type Funnel,
} from '@/lib/analytics';
import { cleanupDb, closeDb, dateDaysAgo, ensureSchema, insertFetchRun, insertJob, PREFIX } from '../helpers/db';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

const id = (s: string) => PREFIX + s;

/** Adds status changes to a job's history, as [from, to, days ago]. */
async function history(jobId: string, ...events: [string | null, string, number][]) {
  for (const [from, to, days] of events) {
    await pool.query('INSERT INTO job_events (job_id, from_status, to_status, at) VALUES ($1, $2, $3, $4)', [
      jobId,
      from,
      to,
      dateDaysAgo(days),
    ]);
  }
}

describe('funnel', () => {
  it('counts the furthest stage each job reached, from its history, and skips duplicates', async () => {
    const before = await funnel();
    await insertJob({ id: 'new', status: 'new' });
    await insertJob({ id: 'filtered', status: 'filtered' });
    await insertJob({ id: 'prepared', status: 'prepared' });
    // Interviewed, then rejected: still counts as applied and interviewed.
    const rejected = await insertJob({ id: 'rejected', status: 'rejected' });
    await history(rejected, ['new', 'applied', 9], ['applied', 'interview', 5], ['interview', 'rejected', 1]);
    const offer = await insertJob({ id: 'offer', status: 'offer', applied_at: dateDaysAgo(20) });
    await insertJob({ id: 'offer-copy', status: 'offer', source: 'linkedin', duplicate_of: offer });
    await insertJob({ id: 'skipped', status: 'skipped' });
    // Applied without any history row (e.g. set before job_events existed).
    await insertJob({ id: 'applied', status: 'applied', applied_at: dateDaysAgo(2) });

    const after = await funnel();
    const delta = Object.fromEntries(Object.keys(after).map((k) => [k, after[k as keyof Funnel] - before[k as keyof Funnel]]));
    expect(delta).toEqual({ matched: 6, prepared: 4, applied: 3, interview: 2, offer: 1, rejected: 1, skipped: 1 });
  });

  it('rate divides, and is null for an empty base', () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 0)).toBeNull();
  });
});

describe('responseRates', () => {
  it('groups applied jobs, counts interviews and offers as replies, and marks small groups', async () => {
    for (let i = 0; i < 6; i++) {
      const j = await insertJob({
        id: `big-${i}`,
        source: 'webtest-big',
        status: i === 0 ? 'interview' : 'applied',
        applied_at: dateDaysAgo(10),
      });
      // Rejected after an interview is still a reply.
      if (i === 1) {
        await pool.query(`UPDATE jobs SET status = 'rejected' WHERE id = $1`, [j]);
        await history(j, ['applied', 'interview', 5], ['interview', 'rejected', 2]);
      }
    }
    await insertJob({ id: 'big-not-applied', source: 'webtest-big', status: 'prepared' });
    const small = await insertJob({ id: 'small-1', source: 'webtest-small', status: 'offer', applied_at: dateDaysAgo(30) });
    await insertJob({ id: 'small-copy', source: 'webtest-small', status: 'offer', applied_at: dateDaysAgo(30), duplicate_of: small });
    await insertJob({ id: 'small-2', source: 'webtest-small', status: 'rejected', applied_at: dateDaysAgo(30) });

    const rows = (await responseRates('source')).filter((r) => r.key?.startsWith('webtest-'));
    expect(rows).toEqual([
      { key: 'webtest-big', n: 6, responded: 2, rate: 2 / 6, small: false },
      { key: 'webtest-small', n: 2, responded: 1, rate: 0.5, small: true },
    ]);
    expect(MIN_N).toBe(5);
  });

  it('works for every dimension, with a null key for jobs that lack the value', async () => {
    await insertJob({
      id: 'dims',
      source: 'webtest-dims',
      country: 'XT',
      cv_version: 'webtest-cv',
      ai_verdict: 'webtest-verdict',
      status: 'interview',
      applied_at: dateDaysAgo(3),
    });
    expect((await responseRates('country')).find((r) => r.key === 'XT')).toMatchObject({ n: 1, responded: 1, small: true });
    expect((await responseRates('cv_version')).find((r) => r.key === 'webtest-cv')).toMatchObject({ n: 1, responded: 1 });
    expect((await responseRates('ai_verdict')).find((r) => r.key === 'webtest-verdict')).toMatchObject({ n: 1 });

    await insertJob({ id: 'no-cv', status: 'applied', applied_at: dateDaysAgo(3) });
    expect((await responseRates('cv_version')).find((r) => r.key === null)!.n).toBeGreaterThanOrEqual(1);
  });

  it('refuses unknown columns', async () => {
    await expect(responseRates('id; DROP TABLE jobs' as never)).rejects.toThrow('Unknown dimension');
  });
});

describe('weeklyActivity', () => {
  it('returns 12 consecutive Monday weeks ending with the current one', async () => {
    const weeks = await weeklyActivity();
    expect(weeks).toHaveLength(12);
    // Weeks start on Monday in the database's time zone (the user's), which may not be UTC.
    const { rows } = await pool.query<{ dow: number }>('SELECT extract(isodow FROM w)::int dow FROM unnest($1::timestamptz[]) w', [
      weeks.map((w) => w.week),
    ]);
    expect(rows.map((r) => r.dow)).toEqual(Array(12).fill(1));
    expect(Date.now() - new Date(weeks[11].week).getTime()).toBeLessThan(7 * 86_400_000);
    expect(Math.round((new Date(weeks[11].week).getTime() - new Date(weeks[0].week).getTime()) / 86_400_000)).toBe(77); // DST-safe
  });

  it('buckets applications by the first move to applied, and new matches by first_seen_at', async () => {
    const before = await weeklyActivity();
    const now = await insertJob({ id: 'w-now', status: 'applied', applied_at: new Date() });
    await history(now, ['prepared', 'applied', 0]);
    // applied_at was reset by a later status change; the history keeps the real date (3 weeks ago).
    const old = await insertJob({ id: 'w-old', status: 'applied', applied_at: new Date(), first_seen_at: dateDaysAgo(30) });
    await history(old, ['new', 'applied', 21], ['interview', 'applied', 0]);
    await insertJob({ id: 'w-match', status: 'new' });
    await insertJob({ id: 'w-filtered', status: 'filtered' });
    await insertJob({ id: 'w-copy', status: 'new', duplicate_of: now });
    await insertJob({ id: 'w-ancient', status: 'applied', applied_at: dateDaysAgo(200), first_seen_at: dateDaysAgo(200) });

    const after = await weeklyActivity();
    const delta = after.map((w, i) => ({ applied: w.applied - before[i].applied, matches: w.matches - before[i].matches }));
    expect(delta[11]).toEqual({ applied: 1, matches: 2 }); // w-now, w-match
    expect(delta[8]).toEqual({ applied: 1, matches: 0 }); // exactly 3 weeks back
    expect(delta.reduce((s, d) => s + d.applied, 0)).toBe(2);
    expect(delta.reduce((s, d) => s + d.matches, 0)).toBe(3); // + w-old, first seen 30 days ago
  });
});

describe('responseDays and median', () => {
  it('measures applied to the first interview or rejection after it', async () => {
    const a = await insertJob({ id: 'r-interview', status: 'interview' });
    await history(a, ['new', 'applied', 10], ['applied', 'interview', 4], ['interview', 'rejected', 1]);
    const b = await insertJob({ id: 'r-rejected', status: 'rejected', applied_at: dateDaysAgo(5) });
    await history(b, ['applied', 'rejected', 3]);
    const c = await insertJob({ id: 'r-waiting', status: 'applied', applied_at: dateDaysAgo(5) });
    await history(c, ['new', 'rejected', 8]); // before applying: not a reply
    const copy = await insertJob({ id: 'r-copy', status: 'rejected', applied_at: dateDaysAgo(5), duplicate_of: a });
    await history(copy, ['applied', 'rejected', 1]);

    const days = Object.fromEntries((await responseDays()).filter((r) => r.id.startsWith(PREFIX)).map((r) => [r.id, r.days]));
    expect(Object.keys(days).sort()).toEqual([id('r-interview'), id('r-rejected')]);
    expect(days[id('r-interview')]).toBeCloseTo(6, 3);
    expect(days[id('r-rejected')]).toBeCloseTo(2, 3);
  });

  it('median handles odd, even and empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([6, 2])).toBe(4);
    expect(median([])).toBeNull();
  });
});

describe('fetch runs', () => {
  it('lists the 7 newest runs with their errors', async () => {
    for (let i = 0; i < 8; i++) await insertFetchRun({ finished_at: new Date(), checked: i, inserted: 1, new_matches: 0 });
    const last = await insertFetchRun({ finished_at: null, checked: 99, errors: [{ company: 'Acme', error: 'HTTP 500' }] });
    const runs = await recentFetchRuns();
    expect(runs).toHaveLength(7);
    expect(runs[0]).toMatchObject({ id: last, checked: 99, finished_at: null, errors: [{ company: 'Acme', error: 'HTTP 500' }] });
    expect(runs.slice(1).map((r) => r.checked)).toEqual([7, 6, 5, 4, 3, 2]);
    expect(runs[1].errors).toEqual([]);
  });

  it('counts the errors of the latest finished run only', async () => {
    await insertFetchRun({
      finished_at: new Date(),
      errors: [
        { company: 'A', error: 'x' },
        { company: 'B', error: 'y' },
      ],
    });
    expect(await lastFetchErrorCount()).toBe(2);
    await insertFetchRun({ finished_at: null, errors: [] }); // still running
    expect(await lastFetchErrorCount()).toBe(2);
    await insertFetchRun({ finished_at: new Date() });
    expect(await lastFetchErrorCount()).toBe(0);
  });
});
