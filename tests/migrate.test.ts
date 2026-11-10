import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { TEST_DB } from './helpers.ts';
import { MIGRATIONS_DIR, migrationFiles, runMigrations } from '../src/migrate.ts';

// Each test gets an empty Postgres schema of its own (via search_path), which acts as a fresh database.
const SCHEMA = 'migrate_test';
const admin = new pg.Pool({ connectionString: TEST_DB, max: 1 });
let db: pg.Pool;
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-migrate-'));

const tables = async () =>
  (
    await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [SCHEMA])
  ).rows.map((r) => r.table_name);
/** The versions from `first` on, in order: what a database at the migration before `first` still has to apply. */
const from = (first: string) =>
  migrationFiles()
    .filter((f) => f >= first)
    .map((f) => f.replace(/\.sql$/, ''));
const recorded = async () =>
  (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY 1')).rows.map((r) => r.version);

/** A migrations folder with the given files. */
function dir(files: Record<string, string>) {
  const d = mkdtempSync(join(tmp, 'm-'));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
  return d;
}

beforeEach(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA}`);
  db = new pg.Pool({ connectionString: TEST_DB, max: 2, options: `-c search_path=${SCHEMA}` });
});
afterEach(() => db.end());
after(async () => {
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await admin.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runMigrations', () => {
  it('creates the whole schema on a fresh database and records each file', async () => {
    const all = migrationFiles().map((f) => f.replace(/\.sql$/, ''));
    assert.deepEqual(await runMigrations(db), all);
    const t = await tables();
    for (const name of ['contacts', 'fetch_runs', 'job_events', 'jobs', 'schema_migrations', 'tasks']) assert.ok(t.includes(name), name);
    assert.deepEqual(
      await recorded(),
      migrationFiles().map((f) => f.replace(/\.sql$/, '')),
    );
    // The baseline's later columns are there too.
    await db.query(`INSERT INTO jobs (id, source, company, title, url) VALUES ('a', 's', 'c', 't', 'u')`);
    const { rows } = await db.query('SELECT form_answers, cover_letter_ai, duplicate_of FROM jobs');
    assert.deepEqual(rows, [{ form_answers: [], cover_letter_ai: false, duplicate_of: null }]);
  });

  it('upgrades a database made by the old schema.sql without losing data', async () => {
    await db.query(readFileSync(join(MIGRATIONS_DIR, '001_baseline.sql'), 'utf8'));
    await db.query(`INSERT INTO jobs (id, source, company, title, url, status) VALUES ('old', 's', 'c', 't', 'u', 'applied')`);
    const all = migrationFiles().map((f) => f.replace(/\.sql$/, ''));
    assert.deepEqual(await runMigrations(db), all);
    assert.deepEqual(await recorded(), all);
    assert.deepEqual((await db.query('SELECT id, status FROM jobs')).rows, [{ id: 'old', status: 'applied' }]);
  });

  it('a second run is a no-op', async () => {
    await runMigrations(db);
    await db.query(`INSERT INTO jobs (id, source, company, title, url) VALUES ('a', 's', 'c', 't', 'u')`);
    assert.deepEqual(await runMigrations(db), []);
    assert.equal((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n, 1);
  });

  it('applies only new files, in name order', async () => {
    const d = dir({ '001_a.sql': 'CREATE TABLE a (n int);' });
    assert.deepEqual(await runMigrations(db, d), ['001_a']);
    writeFileSync(join(d, '003_c.sql'), 'INSERT INTO a VALUES (3);');
    writeFileSync(join(d, '002_b.sql'), 'INSERT INTO a VALUES (2);');
    assert.deepEqual(await runMigrations(db, d), ['002_b', '003_c']);
    assert.deepEqual(
      (await db.query('SELECT n FROM a')).rows.map((r) => r.n),
      [2, 3],
    );
  });

  it('rolls back a failing migration completely and stops there', async () => {
    const d = dir({
      '001_ok.sql': 'CREATE TABLE ok (n int);',
      '002_bad.sql': 'CREATE TABLE half (n int); INSERT INTO ok VALUES (1); SELECT 1 / 0;',
      '003_later.sql': 'CREATE TABLE later (n int);',
    });
    await assert.rejects(runMigrations(db, d), /Migration 002_bad\.sql failed: division by zero/);
    assert.deepEqual(await tables(), ['ok', 'schema_migrations']);
    assert.deepEqual(await recorded(), ['001_ok']);
    assert.equal((await db.query('SELECT count(*)::int n FROM ok')).rows[0].n, 0);
    // Once fixed, the next start picks up where it stopped.
    writeFileSync(join(d, '002_bad.sql'), 'CREATE TABLE half (n int);');
    assert.deepEqual(await runMigrations(db, d), ['002_bad', '003_later']);
  });

  it('concurrent starts apply each file once', async () => {
    const d = dir({ '001_a.sql': 'CREATE TABLE a (n int); INSERT INTO a VALUES (1);' });
    const runs = await Promise.all([runMigrations(db, d), runMigrations(db, d)]);
    assert.deepEqual(runs.flat(), ['001_a']);
    assert.equal((await db.query('SELECT count(*)::int n FROM a')).rows[0].n, 1);
  });

  it('rejects files that do not follow NNN_name.sql', () => {
    assert.throws(() => migrationFiles(dir({ '001_ok.sql': '', 'fix.sql': '' })), /Bad migration file name fix\.sql/);
  });
});

describe('migration 009 (url indexes)', () => {
  // The extension's lookup, with the same expression as web/lib/extension.ts, so a change there that drifts from
  // the index fails here.
  const NORMALIZED = readFileSync(join(import.meta.dirname, '..', 'web', 'lib', 'extension.ts'), 'utf8').match(
    /const NORMALIZED = `([^`]+)`/,
  )![1];

  it('findJobByUrl uses the url and normalized-url indexes', async () => {
    await runMigrations(db);
    await db.query(
      `INSERT INTO jobs (id, source, company, title, url)
       SELECT 'j' || n, 's', 'c', 't', 'https://example.com/jobs/' || n || '?ref=x' FROM generate_series(1, 200) n`,
    );
    await db.query('ANALYZE jobs');
    const client = await db.connect();
    try {
      await client.query('SET enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM jobs WHERE url = $1 OR ${NORMALIZED} = $2
         ORDER BY (url = $1) DESC, (duplicate_of IS NULL) DESC, first_seen_at DESC LIMIT 1`,
        ['https://example.com/jobs/7?ref=x', 'https://example.com/jobs/7'],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      assert.match(plan, /jobs_url\b/, plan);
      assert.match(plan, /jobs_url_normalized/, plan);
    } finally {
      client.release();
    }
  });
});

describe('migration 013 (CV summary)', () => {
  it('adds the summary and edit columns, and the summary and tailored_cv task kinds next to every older kind', async () => {
    await runMigrations(db);
    await db.query(`INSERT INTO jobs (id, source, company, title, url) VALUES ('a', 's', 'c', 't', 'u')`);
    const { rows } = await db.query('SELECT cv_summary, cv_summary_at, cv_summary_edited_at, cover_letter_edited_at FROM jobs');
    assert.deepEqual(rows, [{ cv_summary: null, cv_summary_at: null, cv_summary_edited_at: null, cover_letter_edited_at: null }]);
    const kinds = ['fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter', 'summary', 'tailored_cv'];
    for (const kind of kinds) {
      const jobId = ['fetch', 'rescore'].includes(kind) ? null : 'a';
      await db.query(`INSERT INTO tasks (kind, job_id) VALUES ($1, $2)`, [kind, jobId]);
    }
    assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n, kinds.length);
    await assert.rejects(db.query(`INSERT INTO tasks (kind) VALUES ('bogus')`), /tasks_kind_check/);
  });

  it('upgrades a database that already has the letter kind (migration 011) without losing its tasks', async () => {
    const d = dir({});
    for (const f of migrationFiles().filter((f) => f < '013')) writeFileSync(join(d, f), readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await runMigrations(db, d);
    await db.query(`INSERT INTO jobs (id, source, company, title, url) VALUES ('a', 's', 'c', 't', 'u')`);
    await db.query(`INSERT INTO tasks (kind, job_id) VALUES ('letter', 'a')`);
    assert.equal((await runMigrations(db))[0], '013_cv_summary');
    assert.deepEqual((await db.query('SELECT kind FROM tasks')).rows, [{ kind: 'letter' }]);
  });
});

describe('migration 014 (CV templates)', () => {
  it('adds the template and review columns, and the cv_template, cv_feedback and cv_review task kinds', async () => {
    await runMigrations(db);
    await db.query(`INSERT INTO jobs (id, source, company, title, url) VALUES ('a', 's', 'c', 't', 'u')`);
    const { rows } = await db.query('SELECT cv_template, cv_review, cv_review_at FROM jobs');
    assert.deepEqual(rows, [{ cv_template: null, cv_review: null, cv_review_at: null }]);
    await db.query(`UPDATE jobs SET cv_template = 'modern'`);
    await assert.rejects(db.query(`UPDATE jobs SET cv_template = 'Bad Name; --'`), /check constraint/);
    const kinds = ['fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter', 'summary', 'tailored_cv'];
    for (const kind of [...kinds, 'cv_template', 'cv_feedback', 'cv_review'])
      await db.query(`INSERT INTO tasks (kind, job_id) VALUES ($1, $2)`, [kind, ['fetch', 'rescore'].includes(kind) ? null : 'a']);
    assert.equal((await db.query('SELECT count(*)::int n FROM tasks')).rows[0].n, kinds.length + 3);
    await assert.rejects(db.query(`INSERT INTO tasks (kind) VALUES ('bogus')`), /tasks_kind_check/);
  });

  it('upgrades a database at migration 013 without losing its tasks or CV summaries', async () => {
    const d = dir({});
    for (const f of migrationFiles().filter((f) => f < '014')) writeFileSync(join(d, f), readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await runMigrations(db, d);
    await db.query(`INSERT INTO jobs (id, source, company, title, url, cv_summary) VALUES ('a', 's', 'c', 't', 'u', 'Kept.')`);
    await db.query(`INSERT INTO tasks (kind, job_id) VALUES ('tailored_cv', 'a')`);
    assert.deepEqual(await runMigrations(db), from('014'));
    assert.deepEqual((await db.query('SELECT kind FROM tasks')).rows, [{ kind: 'tailored_cv' }]);
    assert.deepEqual((await db.query('SELECT cv_summary FROM jobs')).rows, [{ cv_summary: 'Kept.' }]);
  });
});

describe('migration 015 (why the AI letter failed)', () => {
  it('adds an empty cover_letter_ai_error to a database at 014 and keeps its letters', async () => {
    const d = dir({});
    for (const f of migrationFiles().filter((f) => f < '015')) writeFileSync(join(d, f), readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await runMigrations(db, d);
    await db.query(`INSERT INTO jobs (id, source, company, title, url, cover_letter) VALUES ('a', 's', 'c', 't', 'u', 'Dear c')`);
    assert.deepEqual(await runMigrations(db), from('015'));
    assert.deepEqual((await db.query('SELECT cover_letter, cover_letter_ai_error FROM jobs')).rows, [
      { cover_letter: 'Dear c', cover_letter_ai_error: null },
    ]);
  });
});

describe('migration 016 (CV headline)', () => {
  it('adds the headline columns and the headline task kind to a database at 015, keeping its summaries', async () => {
    const d = dir({});
    for (const f of migrationFiles().filter((f) => f < '016')) writeFileSync(join(d, f), readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await runMigrations(db, d);
    await db.query(`INSERT INTO jobs (id, source, company, title, url, cv_summary) VALUES ('a', 's', 'c', 't', 'u', 'Kept.')`);
    await db.query(`INSERT INTO tasks (kind, job_id) VALUES ('summary', 'a')`);
    assert.deepEqual(await runMigrations(db), from('016'));
    const { rows } = await db.query('SELECT cv_summary, cv_headline, cv_headline_at, cv_headline_edited_at FROM jobs');
    assert.deepEqual(rows, [{ cv_summary: 'Kept.', cv_headline: null, cv_headline_at: null, cv_headline_edited_at: null }]);
    await db.query(`INSERT INTO tasks (kind, job_id) VALUES ('headline', 'a')`);
    assert.deepEqual((await db.query('SELECT kind FROM tasks ORDER BY id')).rows, [{ kind: 'summary' }, { kind: 'headline' }]);
    await assert.rejects(db.query(`INSERT INTO tasks (kind) VALUES ('bogus')`), /tasks_kind_check/);
  });
});

describe('migration 017 (job list index)', () => {
  it('the job list and the ai:score queue read primaries of one status in AI-score order through jobs_list_idx', async () => {
    const d = dir({});
    for (const f of migrationFiles().filter((f) => f < '017')) writeFileSync(join(d, f), readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
    await runMigrations(db, d);
    await db.query(`INSERT INTO jobs (id, source, company, title, url) VALUES ('kept', 's', 'c', 't', 'u')`);
    assert.equal((await runMigrations(db))[0], '017_jobs_list_index');
    assert.equal((await db.query('SELECT count(*)::int n FROM jobs')).rows[0].n, 1);
    await db.query(
      `INSERT INTO jobs (id, source, company, title, url, status, score, ai_score, duplicate_of)
       SELECT 'j' || n, 's', 'c', 't', 'u' || n, (ARRAY['new', 'filtered', 'applied'])[n % 3 + 1], n % 100,
         CASE WHEN n % 4 = 0 THEN NULL ELSE n % 90 END, CASE WHEN n % 10 = 0 THEN 'j1' END
       FROM generate_series(1, 300) n`,
    );
    await db.query('ANALYZE jobs');
    const client = await db.connect();
    try {
      await client.query('SET enable_seqscan = off');
      await client.query('SET enable_sort = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT id FROM jobs WHERE duplicate_of IS NULL AND status = $1 ORDER BY ai_score DESC NULLS LAST, score DESC LIMIT 50`,
        ['new'],
      );
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      assert.match(plan, /jobs_list_idx/, plan);
      assert.doesNotMatch(plan, /Sort/, plan);
    } finally {
      client.release();
    }
  });
});
