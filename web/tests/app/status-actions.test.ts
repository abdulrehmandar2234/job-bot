import { refresh } from 'next/cache';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStatus, undoStatus } from '@/app/actions';
import { getJob, jobEvents, pool } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));

// setStatus with the status the card showed (`from`), and Undo of the latest status change (History on the job page).
const id = PREFIX + 'status';
const form = (fields: Record<string, string | number>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  return fd;
};
const status = async () => (await getJob(id))!.status;
/** The newest history row (jobEvents sorts by time; rows in one test can share a millisecond, so sort by id). */
const latest = async () => (await jobEvents(id)).sort((a, b) => b.id - a.id)[0];
const undo = async () => undoStatus(null, form({ id, event: (await latest()).id }));

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'new' });
  vi.clearAllMocks();
});
afterAll(closeDb);

describe('setStatus with `from`', () => {
  it('moves the job when it still has the status the card showed', async () => {
    expect(await setStatus(null, form({ id, status: 'applied', from: 'new' }))).toBeNull();
    expect(await status()).toBe('applied');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refuses a stale tab: an Interview job is not pulled back to Applied, and applied_at is kept', async () => {
    await setStatus(null, form({ id, status: 'applied', from: 'new' }));
    await setStatus(null, form({ id, status: 'interview', from: 'applied' }));
    const before = await getJob(id);
    vi.clearAllMocks();

    expect(await setStatus(null, form({ id, status: 'applied', from: 'new' }))).toEqual({
      ok: false,
      message: 'This job changed to interview in another tab — reload to see it',
    });
    const after = await getJob(id);
    expect(after!.status).toBe('interview');
    expect(after!.applied_at).toEqual(before!.applied_at);
    expect(await jobEvents(id)).toHaveLength(2);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('answers "Unknown job" for a job that vanished (dedupe) instead of throwing', async () => {
    await pool.query('DELETE FROM jobs WHERE id = $1', [id]);
    expect(await setStatus(null, form({ id, status: 'applied', from: 'new' }))).toEqual({ ok: false, message: 'Unknown job' });
    expect(await setStatus(null, form({ id, status: 'skipped' }))).toEqual({ ok: false, message: 'Unknown job' });
  });
});

describe('undoStatus', () => {
  it('moves a mistaken "Mark applied" back, clears applied_at and logs the undo', async () => {
    await setStatus(null, form({ id, status: 'applied', from: 'new' }));
    vi.clearAllMocks();
    expect(await undo()).toBeNull();
    const job = await getJob(id);
    expect(job!.status).toBe('new');
    expect(job!.applied_at).toBeNull();
    expect(await latest()).toMatchObject({ from_status: 'applied', to_status: 'new', note: 'undo' });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('puts back the earlier applied_at when the job had been applied to before', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    const first = (await getJob(id))!.applied_at;
    await setStatus(null, form({ id, status: 'new' }));
    await setStatus(null, form({ id, status: 'applied' }));
    expect((await getJob(id))!.applied_at).not.toEqual(first);
    await undo();
    expect(await getJob(id)).toMatchObject({ status: 'new', applied_at: first });
  });

  it('logs the applied_at from before each change and before the undo (prev_applied_at)', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    const appliedAt = (await getJob(id))!.applied_at;
    expect(await latest()).toMatchObject({ to_status: 'applied', prev_applied_at: null });
    await setStatus(null, form({ id, status: 'interview' }));
    expect(await latest()).toMatchObject({ to_status: 'interview', prev_applied_at: appliedAt });
    await undo();
    expect(await latest()).toMatchObject({ to_status: 'applied', note: 'undo', prev_applied_at: appliedAt });
  });

  it('puts back the applied_at of a job applied to without a history row (set before job_events)', async () => {
    const legacy = new Date('2026-01-05T10:00:00Z');
    await pool.query(`UPDATE jobs SET status = 'interview', applied_at = $2 WHERE id = $1`, [id, legacy]);
    await setStatus(null, form({ id, status: 'applied', from: 'interview' }));
    expect((await getJob(id))!.applied_at).not.toEqual(legacy);
    await undo();
    expect(await getJob(id)).toMatchObject({ status: 'interview', applied_at: legacy });
  });

  it('replays the history for an event logged before migration 018 (prev_applied_at NULL)', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    const first = (await getJob(id))!.applied_at;
    await setStatus(null, form({ id, status: 'new' }));
    await setStatus(null, form({ id, status: 'applied' }));
    // Old-style rows: nothing says what applied_at was before them.
    await pool.query('UPDATE job_events SET prev_applied_at = NULL WHERE job_id = $1', [id]);
    await undo();
    expect(await getJob(id)).toMatchObject({ status: 'new', applied_at: first });
  });

  it('keeps applied_at when undoing a later move (Interview back to Applied)', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    const appliedAt = (await getJob(id))!.applied_at;
    await setStatus(null, form({ id, status: 'interview' }));
    await undo();
    expect(await getJob(id)).toMatchObject({ status: 'applied', applied_at: appliedAt });
  });

  it('works for Rejected and Offer, and skips past follow-up entries in the history', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, note) VALUES ($1, 'applied', 'applied', 'Follow-up 1 sent')`,
      [id],
    );
    await setStatus(null, form({ id, status: 'rejected' }));
    await undo();
    expect(await status()).toBe('applied');
    await setStatus(null, form({ id, status: 'interview' }));
    await setStatus(null, form({ id, status: 'offer' }));
    await undo();
    expect(await status()).toBe('interview');
  });

  it('restores a skip with its reason when "Move to matching" is undone', async () => {
    await setStatus(null, form({ id, status: 'skipped', reason: 'seniority' }));
    await setStatus(null, form({ id, status: 'new' }));
    await undo();
    expect(await status()).toBe('skipped');
    expect(await latest()).toMatchObject({ from_status: 'new', to_status: 'skipped', note: 'undo', reason: 'seniority' });
  });

  it('refuses when the job moved on since the history the page showed', async () => {
    await setStatus(null, form({ id, status: 'applied' }));
    const shown = (await latest()).id;
    await setStatus(null, form({ id, status: 'interview' }));
    vi.clearAllMocks();
    expect(await undoStatus(null, form({ id, event: shown }))).toEqual({
      ok: false,
      message: 'This job changed to interview in another tab — reload to see it',
    });
    expect(await status()).toBe('interview');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses when the status changed without a history entry, a second undo, and a job with no history', async () => {
    expect(await undoStatus(null, form({ id, event: 1 }))).toEqual({ ok: false, message: 'Nothing to undo' });

    await setStatus(null, form({ id, status: 'applied' }));
    await pool.query(`UPDATE jobs SET status = 'interview' WHERE id = $1`, [id]);
    expect(await undo()).toEqual({ ok: false, message: 'Nothing to undo' });
    expect(await status()).toBe('interview');

    await pool.query(`UPDATE jobs SET status = 'applied' WHERE id = $1`, [id]);
    await undo();
    expect(await status()).toBe('new');
    expect(await undo()).toEqual({ ok: false, message: 'Nothing to undo' }); // no redo
    expect(await status()).toBe('new');
  });

  it('answers a missing job id, a bad history id and an unknown job without throwing', async () => {
    expect(await undoStatus(null, form({ event: 1 }))).toEqual({ ok: false, message: 'Missing job id' });
    expect(await undoStatus(null, form({ id, event: 'x' }))).toEqual({ ok: false, message: 'Invalid history entry' });
    expect(await undoStatus(null, form({ id: PREFIX + 'nope', event: 1 }))).toEqual({ ok: false, message: 'Unknown job' });
  });
});
