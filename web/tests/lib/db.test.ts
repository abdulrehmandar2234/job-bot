import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countJobs,
  pageSize,
  PAGE_SIZES,
  getJob,
  jobEvents,
  lastRun,
  listJobs,
  PAGE_SIZE,
  pool,
  postingsFor,
  statusCounts,
  weekStats,
} from '@/lib/db';
import { cleanupDb, closeDb, daysAgo, ensureSchema, insertFetchRun, insertJob, ours, PREFIX } from '../helpers/db';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

const id = (s: string) => PREFIX + s;

describe('listJobs everyTab (search across every status)', () => {
  it('finds a company in every tab, but never a filtered job outside the target countries', async () => {
    const q = 'everytabco';
    await insertJob({ id: 'et-new', company: `Acme ${q}`, status: 'new' });
    await insertJob({ id: 'et-prep', company: `Acme ${q}`, status: 'prepared' });
    await insertJob({ id: 'et-skip', company: `Acme ${q}`, status: 'skipped' });
    await insertJob({ id: 'et-filt', company: `Acme ${q}`, status: 'filtered', country: 'AE' });
    await insertJob({ id: 'et-nowhere', company: `Acme ${q}`, status: 'filtered', country: null });
    await insertJob({ id: 'et-dup', company: `Acme ${q}`, status: 'new' });
    await pool.query(`UPDATE jobs SET duplicate_of = $1 WHERE id = $2`, [id('et-new'), id('et-dup')]);
    const all = await listJobs({ status: 'new', q, everyTab: true });
    expect(ours(all).sort()).toEqual([id('et-filt'), id('et-new'), id('et-prep'), id('et-skip')]);
    expect(await countJobs({ status: 'new', q, everyTab: true })).toBe(4);
    expect(ours(await listJobs({ status: 'new', q }))).toEqual([id('et-new')]); // one tab only
  });
});

describe('pageSize', () => {
  it('accepts only the offered sizes, else the default 25', () => {
    expect(PAGE_SIZES).toEqual([10, 25, 50, 100]);
    expect([10, '50', '100', 25].map(pageSize)).toEqual([10, 50, 100, 25]);
    expect([undefined, '', '7', '1000', 'abc', '-10', '25.5'].map(pageSize)).toEqual([25, 25, 25, 25, 25, 25, 25]);
  });
});

describe('listJobs visa filter', () => {
  it('keeps only jobs whose posting offers visa/relocation, or that need no visa', async () => {
    const q = 'visafiltertest';
    for (const e of ['offered', 'not-needed', 'can-sponsor', 'silent'] as const)
      await insertJob({ id: `visa-${e}`, title: `TG ${q} ${e}`, status: 'new', visa_evidence: e });
    await insertJob({ id: 'visa-none', title: `TG ${q} none`, status: 'new' });
    expect(ours(await listJobs({ status: 'new', q, visaOnly: true })).sort()).toEqual([id('visa-not-needed'), id('visa-offered')]);
    expect(await countJobs({ status: 'new', q, visaOnly: true })).toBe(2);
    expect(await countJobs({ status: 'new', q })).toBe(5);
    expect((await listJobs({ status: 'new', q })).find((r) => r.id === id('visa-silent'))!.visa_evidence).toBe('silent');
  });
});

describe('listJobs paging and countJobs', () => {
  it('returns one page at a time in a stable order, and counts every match', async () => {
    const q = 'pagingtest';
    for (let i = 0; i < 7; i++) await insertJob({ id: `page-${i}`, title: `TG ${q} ${i}`, status: 'new', score: 60 });
    const f = { status: 'new' as const, q };
    expect(await countJobs(f)).toBe(7);
    const p1 = await listJobs(f, 1, 3);
    const p2 = await listJobs(f, 2, 3);
    const p3 = await listJobs(f, 3, 3);
    expect([p1.length, p2.length, p3.length]).toEqual([3, 3, 1]);
    // Same score, so the id breaks the tie: no job shows on two pages.
    expect(new Set([...p1, ...p2, ...p3].map((r) => r.id)).size).toBe(7);
    expect(await listJobs(f, 4, 3)).toEqual([]);
    expect((await listJobs(f, 0, 3)).map((r) => r.id)).toEqual(p1.map((r) => r.id)); // bad page numbers mean page 1
    expect(await countJobs({ ...f, q: 'nothing-matches-this' })).toBe(0);
    expect(PAGE_SIZE).toBe(25);
    expect(await listJobs(f)).toHaveLength(7); // default page size
  });
});

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

  it('selects closed_at, so a card can say the posting closed', async () => {
    const closed = new Date('2026-10-20T10:00:00Z');
    await insertJob({ id: 'c', status: 'applied', closed_at: closed });
    await insertJob({ id: 'o', status: 'applied' });
    const rows = await listJobs({ status: 'applied' });
    expect(rows.find((r) => r.id === id('c'))!.closed_at).toEqual(closed);
    expect(rows.find((r) => r.id === id('o'))!.closed_at).toBeNull();
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
    expect(ours(await listJobs({ status: 'new', min: 60 })).sort()).toEqual([id('ai-high'), id('edge'), id('kw-high')]);
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

  it('matches %, _ and \\ in the search text literally, not as wildcards', async () => {
    await insertJob({ id: 'us', company: 'Acme', title: 'Zq_dev Engineer' });
    await insertJob({ id: 'pct', company: 'Zq 100% Remote', title: 'Engineer' });
    await insertJob({ id: 'bs', company: 'Acme', title: 'Zq\\path Engineer' });
    await insertJob({ id: 'plain', company: 'Acme', title: 'Zqxdev 100x Engineer' });
    const search = async (q: string) => ours(await listJobs({ status: 'new', q })).sort();
    expect(await search('_')).toEqual([id('us')]);
    expect(await search('%')).toEqual([id('pct')]);
    expect(await search('\\')).toEqual([id('bs')]);
    expect(await search('zq_dev')).toEqual([id('us')]);
    expect(await search('100%')).toEqual([id('pct')]);
    expect(await countJobs({ status: 'new', q: 'zq_' })).toBe(1);
    // Ordinary text still matches as a substring.
    expect(await search('zq')).toEqual([id('bs'), id('pct'), id('plain'), id('us')].sort());
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
    expect(ours(await listJobs({ status: 'new' }))).toEqual([
      id('ai-85'),
      id('ai-60'),
      id('unrev-90'),
      id('unrev-50-new'),
      id('unrev-50-old'),
    ]);
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

  it('returns an empty map for no ids without querying (an empty tab costs no round-trip)', async () => {
    const spy = vi.spyOn(pool, 'query');
    try {
      expect((await postingsFor([])).size).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('getJob', () => {
  it('returns the full row, including description and form answers', async () => {
    await insertJob({
      id: 'g',
      description: 'Full JD',
      cover_letter: 'Dear team',
      matched: ['php'],
      form_answers: [{ question: 'Q?', answer: 'A', needs_input: false, note: '' }],
    });
    const job = await getJob(id('g'));
    expect(job).toMatchObject({
      id: id('g'),
      description: 'Full JD',
      cover_letter: 'Dear team',
      matched: ['php'],
      form_answers: [{ question: 'Q?', answer: 'A', needs_input: false, note: '' }],
      cover_letter_ai: false,
    });
    expect(job!.first_seen_at).toBeInstanceOf(Date);
  });

  it('returns null for an unknown id', async () => {
    expect(await getJob(id('missing'))).toBeNull();
  });
});

describe('jobEvents', () => {
  it("returns a job's events, newest first", async () => {
    await insertJob({ id: 'e' });
    await insertJob({ id: 'other' });
    await pool.query(
      `INSERT INTO job_events (job_id, at, from_status, to_status, note) VALUES
      ($1, now() - interval '2 days', 'new', 'prepared', null),
      ($1, now() - interval '1 day', 'prepared', 'applied', 'via site'),
      ($2, now(), 'new', 'skipped', null)`,
      [id('e'), id('other')],
    );
    const events = await jobEvents(id('e'));
    expect(events.map((e) => [e.from_status, e.to_status, e.note])).toEqual([
      ['prepared', 'applied', 'via site'],
      ['new', 'prepared', null],
    ]);
  });

  it('is removed together with the job', async () => {
    await insertJob({ id: 'e' });
    await pool.query(`INSERT INTO job_events (job_id, to_status) VALUES ($1, 'applied')`, [id('e')]);
    await cleanupDb();
    expect(await jobEvents(id('e'))).toEqual([]);
  });
});

describe('weekStats', () => {
  it('counts applications in the last 7 days and non-filtered, non-duplicate jobs first seen today', async () => {
    const before = await weekStats();
    await insertJob({ id: 'ap-recent', status: 'applied', applied_at: daysAgo(2), first_seen_at: daysAgo(20) });
    await insertJob({ id: 'ap-old', status: 'applied', applied_at: daysAgo(8), first_seen_at: daysAgo(20) });
    await insertJob({ id: 'today' });
    await insertJob({ id: 'today-filtered', status: 'filtered' });
    await insertJob({ id: 'yesterday', first_seen_at: daysAgo(2) });
    // A copy of a job found on another site is the same job, shown under "Posted on": counted once in both stats.
    await insertJob({ id: 'today-copy', source: 'linkedin', duplicate_of: id('today') });
    await insertJob({ id: 'ap-copy', source: 'linkedin', status: 'applied', applied_at: daysAgo(2), duplicate_of: id('ap-recent') });
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
