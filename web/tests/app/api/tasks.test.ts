import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '@/app/api/tasks/route';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob } from '../../helpers/db';

const get = async (job?: string) => {
  const res = await GET(new NextRequest(`http://localhost:3100/api/tasks${job ? `?job=${encodeURIComponent(job)}` : ''}`));
  return { res, body: await res.json() as { active: number[] } };
};
const addTask = async (kind: string, jobId: string | null, status = 'queued', extra = '') =>
  (await pool.query<{ id: number }>(
    `INSERT INTO tasks (kind, job_id, status${extra ? ', deadline' : ''}) VALUES ($1, $2, $3${extra ? `, ${extra}` : ''}) RETURNING id`,
    [kind, jobId, status])).rows[0].id;

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('GET /api/tasks', () => {
  it('lists the ids of queued and running tasks, uncached', async () => {
    const a = await insertJob({ id: 'tasks-a' });
    const fetchTask = await addTask('fetch', null, 'running', `now() + interval '10 minutes'`);
    const queued = await addTask('prepare', a);
    await addTask('ai_review', a, 'done');
    await addTask('answers', a, 'failed');

    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.active).toEqual(expect.arrayContaining([fetchTask, queued]));
    expect(body.active).toHaveLength(2);
  });

  it('limits to one job with ?job=', async () => {
    const a = await insertJob({ id: 'tasks-a' });
    const b = await insertJob({ id: 'tasks-b' });
    await addTask('fetch', null);
    const mine = await addTask('prepare', a);
    await addTask('prepare', b);
    expect((await get(a)).body.active).toEqual([mine]);
    expect((await get('webtest:none')).body.active).toEqual([]);
  });

  it('expires a running task whose worker died, so polling stops', async () => {
    const dead = await addTask('fetch', null, 'running', `now() - interval '1 second'`);
    expect((await get()).body.active).toEqual([]);
    const { rows: [t] } = await pool.query('SELECT status, error FROM tasks WHERE id = $1', [dead]);
    expect(t).toMatchObject({ status: 'failed', error: expect.stringMatching(/Timed out/) });
  });
});
