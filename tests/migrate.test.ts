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

const tables = async () => (await db.query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [SCHEMA])).rows.map((r) => r.table_name);
const recorded = async () => (await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY 1')).rows.map((r) => r.version);

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
    assert.deepEqual(await recorded(), migrationFiles().map((f) => f.replace(/\.sql$/, '')));
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
    assert.deepEqual((await db.query('SELECT n FROM a')).rows.map((r) => r.n), [2, 3]);
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
