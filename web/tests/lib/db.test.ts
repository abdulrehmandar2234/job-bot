import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getJob, jobEvents, lastRun, listJobs, pool, postingsFor, statusCounts, weekStats } from '@/lib/db';
import { cleanupDb, closeDb, daysAgo, ensureSchema, insertFetchRun, insertJob, ours, PREFIX } from '../helpers/db';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

const id = (s: string) => PREFIX + s;

describe('listJobs', () => {
  it('returns jobs of one status and hides duplicates', async () => {
    await insertJob({ id: 'a', status: 'new' });
    await insertJob({ id: 'b', status: 'applied' });
    await insertJob({ id: 'a-copy', status: 'new', duplicate_of: id('a') });
    expect(ours(await listJobs({ status: 'new' }))).toEqual([id('a')]);
    expect(ours(await listJobs({ status: 'applied' }))).toEqual([id('b')]);
  });

  it('does not load the description or cover letter for the list', async () => {
    await insertJob({ id: 'a', description: 'long text', cover_letter: 'Dear…' });
    const [row] = (await listJobs({ status: 'new' })).filter((r) => r.id === id('a'));
    expect(row.description).toBe('');
    expect(row.cover_letter).toBeNull();
    expect(row.company).toBe('Acme');
  });

  it('filters by country', async () => {
    await insertJob({ id: 'ae', country: 'AE' });
    await insertJob({ id: 'nl', country: 'NL' });
    expect(ours(await listJobs({ status: 'new', country: 'NL' }))).toEqual([id('nl')]);
  });

  it('min score uses the AI score when there is one, else the keyword score', async () => {
    await insertJob({ id: 'kw-high', score: 80, ai_score: null });
    await insertJob({ id: 'ai-low', score: 90, ai_score: 40 });
    await insertJob({ id: 'ai-high', score: 30, ai_score: 70 });
    await insertJob({ id: 'edge', score: 60 });
    expect(ours(await listJobs({ status: 'new', min: 60 })).sort())
      .toEqual([id('ai-high'), id('edge'), id('kw-high')]);
  });

  it('searches company and title case-insensitively', async () => {
    await insertJob({ id: 'c', company: 'Zorblax Labs', title: 'Engineer' });
    await insertJob({ id: 't', company: 'Acme', title: 'Senior ZORBLAX Developer' });
    await insertJob({ id: 'x', company: 'Acme', title: 'Engineer' });
    expect(ours(await listJobs({ status: 'new', q: 'zorblax' })).sort()).toEqual([id('c'), id('t')]);
  });

  it('treats the search text as data, not SQL', async () => {
    await insertJob({ id: 'q', company: "O'Reilly" });
    expect(ours(await listJobs({ status: 'new', q: "O'Reilly" }))).toEqual([id('q')]);
    expect(ours(await listJobs({ status: 'new', q: "' OR 1=1 --" }))).toEqual([]);
  });

  it('days keeps jobs posted (or, without a post date, first seen) within that many days', async () => {
    await insertJob({ id: 'fresh', posted_at: daysAgo(2), first_seen_at: daysAgo(30) });
    await insertJob({ id: 'old-post', posted_at: daysAgo(10), first_seen_at: daysAgo(1) });
    await insertJob({ id: 'no-date-recent', posted_at: null, first_seen_at: daysAgo(3) });
    await insertJob({ id: 'no-date-old', posted_at: null, first_seen_at: daysAgo(9) });
    expect(ours(await listJobs({ status: 'new', days: 7 })).sort()).toEqual([id('fresh'), id('no-date-recent')]);
  });

  it('only shows filtered jobs that are in a target country', async () => {
    await insertJob({ id: 'f-ae', status: 'filtered', country: 'AE' });
    await insertJob({ id: 'f-none', status: 'filtered', country: null });
    expect(ours(await listJobs({ status: 'filtered' }))).toEqual([id('f-ae')]);
  });

  it('sorts matching jobs by AI score (unreviewed last), then keyword score, then newest', async () => {
    await insertJob({ id: 'unrev-90', score: 90, ai_score: null });
    await insertJob({ id: 'ai-60', score: 10, ai_score: 60 });
    await insertJob({ id: 'ai-85', score: 20, ai_score: 85 });
    await insertJob({ id: 'unrev-50-old', score: 50, posted_at: daysAgo(5) });
    await insertJob({ id: 'unrev-50-new', score: 50, posted_at: daysAgo(1) });
    expect(ours(await listJobs({ status: 'new' })))
      .toEqual([id('ai-85'), id('ai-60'), id('unrev-90'), id('unrev-50-new'), id('unrev-50-old')]);
  });

  it('sort=newest orders by post date, falling back to first seen', async () => {
    await insertJob({ id: 'p3', score: 99, posted_at: daysAgo(3) });
    await insertJob({ id: 'p1', score: 10, posted_at: daysAgo(1) });
    await insertJob({ id: 's2', score: 50, posted_at: null, first_seen_at: daysAgo(2) });
    expect(ours(await listJobs({ status: 'new', sort: 'newest' }))).toEqual([id('p1'), id('s2'), id('p3')]);
  });

  it('orders pipeline statuses by applied date, falling back to first seen', async () => {
    await insertJob({ id: 'app-old', status: 'applied', applied_at: daysAgo(5), first_seen_at: daysAgo(1) });
    await insertJob({ id: 'app-new', status: 'applied', applied_at: daysAgo(1), first_seen_at: daysAgo(10) });
    await insertJob({ id: 'app-none', status: 'applied', applied_at: null, first_seen_at: daysAgo(3) });
    expect(ours(await listJobs({ status: 'applied' }))).toEqual([id('app-new'), id('app-none'), id('app-old')]);
  });

  it('combines filters', async () => {
    await insertJob({ id: 'hit', country: 'AE', score: 80, company: 'Qwopple' });
    await insertJob({ id: 'wrong-country', country: 'SA', score: 80, company: 'Qwopple' });
    await insertJob({ id: 'low', country: 'AE', score: 20, company: 'Qwopple' });
    expect(ours(await listJobs({ status: 'new', country: 'AE', min: 50, q: 'qwopple' }))).toEqual([id('hit')]);
  });
});

describe('statusCounts', () => {
  it('counts per status, without duplicates or filtered jobs outside target countries', async () => {
    const before = await statusCounts();
    await insertJob({ id: 'n1' });
    await insertJob({ id: 'n2' });
    await insertJob({ id: 'n2-copy', duplicate_of: id('n2') });
    await insertJob({ id: 'ap', status: 'applied' });
    await insertJob({ id: 'f-ae', status: 'filtered', country: 'AE' });
    await insertJob({ id: 'f-none', status: 'filtered', country: null });
    const after = await statusCounts();
    const delta = (s: keyof typeof after) => (after[s] ?? 0) - (before[s] ?? 0);
    expect(delta('new')).toBe(2);
    expect(delta('applied')).toBe(1);
    expect(delta('filtered')).toBe(1);
    expect(typeof after.new).toBe('number');
  });
});

describe('postingsFor', () => {
  it('lists the primary posting first, then its copies by first seen, keyed by primary id', async () => {
    await insertJob({ id: 'p', source: 'greenhouse', url: 'https://gh/p', first_seen_at: daysAgo(1) });
    await insertJob({ id: 'p-bayt', source: 'bayt', url: 'https://bayt/p', duplicate_of: id('p'), first_seen_at: daysAgo(5) });
    await insertJob({ id: 'p-li', source: 'linkedin', url: 'https://li/p', duplicate_of: id('p'), first_seen_at: daysAgo(3) });
    await insertJob({ id: 'solo', source: 'lever', url: 'https://lever/solo' });
    await insertJob({ id: 'other', source: 'ashby' });

    const map = await postingsFor([id('p'), id('solo')]);
    expect([...map.keys()].sort()).toEqual([id('p'), id('solo')]);
    expect(map.get(id('p'))).toEqual([
      { id: id('p'), source: 'greenhouse', url: 'https://gh/p' },
      { id: id('p-bayt'), source: 'bayt', url: 'https://bayt/p' },
      { id: id('p-li'), source: 'linkedin', url: 'https://li/p' },
    ]);
    expect(map.get(id('solo'))).toEqual([{ id: id('solo'), source: 'lever', url: 'https://lever/solo' }]);
  });

  it('returns an empty map for no ids', async () => {
    expect((await postingsFor([])).size).toBe(0);
  });
});

describe('getJob', () => {
  it('returns the full row, including description and form answers', async () => {
    await insertJob({ id: 'g', description: 'Full JD', cover_letter: 'Dear team', matched: ['php'],
      form_answers: [{ question: 'Q?', answer: 'A', needs_input: false, note: '' }] });
    const job = await getJob(id('g'));
    expect(job).toMatchObject({ id: id('g'), description: 'Full JD', cover_letter: 'Dear team', matched: ['php'],
      form_answers: [{ question: 'Q?', answer: 'A', needs_input: false, note: '' }], cover_letter_ai: false });
    expect(job!.first_seen_at).toBeInstanceOf(Date);
  });

  it('returns null for an unknown id', async () => {
    expect(await getJob(id('missing'))).toBeNull();
  });
});

describe('jobEvents', () => {
  it('returns a job\'s events, newest first', async () => {
    await insertJob({ id: 'e' });
    await insertJob({ id: 'other' });
    await pool.query(`INSERT INTO job_events (job_id, at, from_status, to_status, note) VALUES
      ($1, now() - interval '2 days', 'new', 'prepared', null),
      ($1, now() - interval '1 day', 'prepared', 'applied', 'via site'),
      ($2, now(), 'new', 'skipped', null)`, [id('e'), id('other')]);
    const events = await jobEvents(id('e'));
    expect(events.map((e) => [e.from_status, e.to_status, e.note]))
      .toEqual([['prepared', 'applied', 'via site'], ['new', 'prepared', null]]);
  });

  it('is removed together with the job', async () => {
    await insertJob({ id: 'e' });
    await pool.query(`INSERT INTO job_events (job_id, to_status) VALUES ($1, 'applied')`, [id('e')]);
    await cleanupDb();
    expect(await jobEvents(id('e'))).toEqual([]);
  });
});

describe('weekStats', () => {
  it('counts applications in the last 7 days and non-filtered jobs first seen today', async () => {
    const before = await weekStats();
    await insertJob({ id: 'ap-recent', status: 'applied', applied_at: daysAgo(2), first_seen_at: daysAgo(20) });
    await insertJob({ id: 'ap-old', status: 'applied', applied_at: daysAgo(8), first_seen_at: daysAgo(20) });
    await insertJob({ id: 'today' });
    await insertJob({ id: 'today-filtered', status: 'filtered' });
    await insertJob({ id: 'yesterday', first_seen_at: daysAgo(2) });
    const after = await weekStats();
    expect(after.applied_week - before.applied_week).toBe(1);
    expect(after.new_today - before.new_today).toBe(1);
  });
});

describe('lastRun', () => {
  it('returns the latest finished fetch run, ignoring one still running', async () => {
    const finished = await insertFetchRun({ finished_at: new Date(), checked: 120, inserted: 7, new_matches: 3 });
    await insertFetchRun({ finished_at: null });
    const run = await lastRun();
    expect(run).toMatchObject({ id: finished, checked: 120, inserted: 7, new_matches: 3 });
    expect(run!.finished_at).toBeInstanceOf(Date);
  });
});
