import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '@/lib/db';
import { MIN_SKIPS, skipInsights, skipOnlyWords, skipReasonCounts, skipTitles, suggestions, titleWords } from '@/lib/skip-insights';
import { cleanupDb, closeDb, ensureSchema, insertJob } from '../helpers/db';

describe('titleWords', () => {
  it('lower-cases, splits on anything but letters and digits, and drops stopwords, numbers and duplicates', () => {
    expect(titleWords('Principal Engineer (Remote) - Java/Kotlin, Java 17')).toEqual(['principal', 'engineer', 'java', 'kotlin']);
    expect(titleWords('C++ & .NET Developer')).toEqual(['net', 'developer']);
  });
});

describe('skipOnlyWords', () => {
  it('counts skipped jobs per word, leaving out words of kept titles and words roleExclude already matches', () => {
    const skipped = ['Principal Engineer', 'Principal Backend Engineer', 'Staff Engineer', 'Golang Engineer'];
    const kept = ['Senior Backend Engineer'];
    expect(skipOnlyWords(skipped, kept, 'golang|\\bjava\\b')).toEqual([
      { word: 'principal', skips: 2 },
      { word: 'staff', skips: 1 },
    ]);
  });

  it('treats a missing or invalid roleExclude as covering nothing', () => {
    expect(skipOnlyWords(['Golang Engineer'], ['Engineer'], '([')).toEqual([{ word: 'golang', skips: 1 }]);
    expect(skipOnlyWords(['Golang Engineer'], ['Engineer'], null)).toEqual([{ word: 'golang', skips: 1 }]);
  });
});

describe('suggestions', () => {
  const words = [
    { word: 'principal', skips: 9 },
    { word: 'staff', skips: MIN_SKIPS },
    { word: 'lead', skips: MIN_SKIPS - 1 },
  ];

  it(`suggests a whole-word pattern from ${MIN_SKIPS} skips on, as a valid regex that matches the word`, () => {
    const s = suggestions(words, ['Senior Laravel Developer']);
    expect(s).toEqual([
      { word: 'principal', skips: 9, pattern: '\\bprincipal\\b' },
      { word: 'staff', skips: MIN_SKIPS, pattern: '\\bstaff\\b' },
    ]);
    for (const x of s) {
      const re = new RegExp(x.pattern, 'i');
      expect(re.test(`Senior ${x.word} engineer`)).toBe(true);
      expect(re.test(`${x.word}ing`)).toBe(false); // whole words only
    }
    // Appended to roleExclude, the result is still one valid regex.
    expect(() => new RegExp(`golang|${s.map((x) => x.pattern).join('|')}`, 'i')).not.toThrow();
  });

  it('never suggests a pattern that matches a kept title, or a word that is not plain letters and digits', () => {
    expect(suggestions(words, ['Staff Software Engineer']).map((s) => s.word)).toEqual(['principal']);
    expect(
      suggestions(
        [
          { word: 'c++', skips: 9 },
          { word: 'a.b', skips: 9 },
        ],
        [],
      ),
    ).toEqual([]);
  });

  it('respects the threshold and the limit', () => {
    expect(suggestions(words, [], 10)).toEqual([]);
    expect(suggestions(words, [], 1, 1).map((s) => s.word)).toEqual(['principal']);
  });
});

describe('queries', () => {
  beforeAll(ensureSchema);
  beforeEach(cleanupDb);
  afterAll(closeDb);

  const skip = async (id: string, title: string, reason: string | null, status = 'skipped') => {
    const jobId = await insertJob({ id, title, status: status as 'skipped' });
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status, reason) VALUES ($1, 'new', 'skipped', $2)`, [jobId, reason]);
    return jobId;
  };

  it('counts each skipped job once by its latest reason, ignoring jobs moved back and duplicates', async () => {
    const a = await skip('si-1', 'Principal Engineer', 'stack');
    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, reason, at) VALUES ($1, 'new', 'skipped', 'seniority', now() + interval '1 minute')`,
      [a],
    );
    await skip('si-2', 'Principal Developer', 'seniority');
    await skip('si-3', 'Sales Engineer', null);
    await skip('si-4', 'Back in play', 'salary', 'new');
    const dup = await skip('si-5', 'Principal Engineer', 'stack');
    await pool.query(`UPDATE jobs SET duplicate_of = $1 WHERE id = $2`, [a, dup]);

    expect(await skipReasonCounts()).toEqual([
      { reason: 'seniority', n: 2 },
      { reason: null, n: 1 },
    ]);
  });

  it('lists titles skipped for stack or seniority, and the titles of jobs still in play', async () => {
    await skip('si-1', 'Principal Engineer', 'stack');
    await skip('si-2', 'Too Low Pay Dev', 'salary');
    await insertJob({ id: 'si-k1', title: 'Senior Developer', status: 'applied' });
    await insertJob({ id: 'si-k2', title: 'Filtered Thing', status: 'filtered' });
    const t = await skipTitles();
    expect(t.skipped).toEqual(['Principal Engineer']);
    expect(t.kept).toEqual(['Senior Developer']);
  });

  it('skipInsights puts it together', async () => {
    for (let i = 0; i < MIN_SKIPS; i++) await skip(`si-${i}`, `Principal Engineer ${i}`, 'seniority');
    await insertJob({ id: 'si-k', title: 'Senior Engineer' });
    const r = await skipInsights('golang');
    expect(r.counts).toEqual([{ reason: 'seniority', n: MIN_SKIPS }]);
    expect(r.words).toEqual([{ word: 'principal', skips: MIN_SKIPS }]);
    expect(r.suggestions).toEqual([{ word: 'principal', skips: MIN_SKIPS, pattern: '\\bprincipal\\b' }]);
    expect((await skipInsights('principal')).suggestions).toEqual([]);
  });
});
