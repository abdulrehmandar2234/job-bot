import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActionError } from '@/lib/action-state';
import { pool } from '@/lib/db';
import { assertJob, canUndo, isStatusChange, jobIdOf, lockJob, withJobLock } from '@/lib/job-lock';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

const id = PREFIX + 'lock';

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  await insertJob({ id, status: 'applied' });
});
afterAll(closeDb);

describe('job checks shared by the job actions', () => {
  it('jobIdOf refuses a missing or non-string id', () => {
    expect(jobIdOf(id)).toBe(id);
    for (const v of [null, '', undefined, new Blob()]) expect(() => jobIdOf(v)).toThrow(new ActionError('Missing job id'));
  });

  it('assertJob answers the id of an existing job, and Unknown job otherwise', async () => {
    expect(await assertJob(id)).toBe(id);
    await expect(assertJob(PREFIX + 'nope')).rejects.toThrow(new ActionError('Unknown job'));
    await expect(assertJob(null)).rejects.toThrow(new ActionError('Missing job id'));
  });

  it('withJobLock gives the locked row, commits the work and returns its result', async () => {
    const result = await withJobLock(id, async (client, job) => {
      expect(job).toMatchObject({ id, status: 'applied', applied_at: null });
      await client.query(`UPDATE jobs SET status = 'interview' WHERE id = $1`, [id]);
      return 'done';
    });
    expect(result).toBe('done');
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [id])).rows[0].status).toBe('interview');
  });

  it('withJobLock rolls back when the work throws, and answers Unknown job for a vanished row', async () => {
    await expect(
      withJobLock(id, async (client) => {
        await client.query(`UPDATE jobs SET status = 'interview' WHERE id = $1`, [id]);
        throw new ActionError('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');
    expect((await pool.query('SELECT status FROM jobs WHERE id = $1', [id])).rows[0].status).toBe('applied');
    await expect(withJobLock(PREFIX + 'gone', async () => 'never')).rejects.toThrow(new ActionError('Unknown job'));
  });

  it('lockJob holds the row: a second transaction waits until the first ends', async () => {
    const a = await pool.connect();
    try {
      await a.query('BEGIN');
      await lockJob(a, id);
      let waited = true;
      const b = withJobLock(id, async (_c, job) => {
        waited = false;
        return job.status;
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(waited).toBe(true);
      await a.query(`UPDATE jobs SET status = 'offer' WHERE id = $1`, [id]);
      await a.query('COMMIT');
      expect(await b).toBe('offer'); // it read the row after the first transaction's change
    } finally {
      a.release();
    }
  });
});

describe('canUndo', () => {
  const e = (from_status: string | null, to_status: string, note: string | null = null) => ({ from_status, to_status, note });
  it.each([
    ['the latest change, while the job is still there', e('new', 'applied'), 'applied', true],
    ['a change the job has moved on from', e('new', 'applied'), 'interview', false],
    ['an undo (no redo)', e('applied', 'new', 'undo'), 'new', false],
    ['a follow-up entry (no status change)', e('applied', 'applied', 'Follow-up 1 sent'), 'applied', false],
    ['a row with no previous status', e(null, 'new'), 'new', false],
    ['nothing', undefined, 'new', false],
  ])('%s', (_, event, status, expected) => {
    expect(canUndo(event, status)).toBe(expected);
    if (event) expect(isStatusChange(event)).toBe(event.from_status !== null && event.from_status !== event.to_status);
  });
});
