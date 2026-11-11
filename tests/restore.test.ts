import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { raw, TEST_DB } from './helpers.ts';
import { backup, backupOptions, findPgDump, findPsql, restore, restoreOptions } from '../src/backup.ts';
import { save } from '../src/commands/shared.ts';
import { migrate, pool } from '../src/db.ts';

// A real round trip: `bot backup` of the test database, then `bot restore` of that file into a scratch database
// (<test db>_restore, e.g. job_bot_test_bot_restore), which is dropped afterwards. It needs the real pg_dump and psql
// (PATH or the usual install folders) and is skipped without them, so CI without the PostgreSQL client stays green.
// The fake-psql tests of every refusal and argument are in tests/backup.test.ts.

const psql = findPsql();
const pgDump = findPgDump();
const SOURCE = new URL(TEST_DB).pathname.slice(1);
const SCRATCH = `${SOURCE}_restore`;
/** Never anything but a test database, whatever the environment says. */
const testOnly = (db: string) => {
  if (!/^job_bot_test\w*$/.test(db)) throw new Error(`restore.test.ts only touches job_bot_test* databases, not ${db}`);
  return db;
};
const JOB = 'restoretest:1';

/** pg_dump's major version ("pg_dump (PostgreSQL) 18.4" → 18), or 0 when it cannot be read. */
const clientMajor = (bin: string) => {
  try {
    return Number(/(\d+)(?:\.\d+)?/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true }))?.[1] ?? 0);
  } catch {
    return 0;
  }
};

describe('backup and restore round trip', { skip: psql && pgDump ? false : 'needs the real pg_dump and psql' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'talaash-restore-'));
  const env = { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_BACKUP_DIR: dir, JOB_BOT_BACKUP_DB: '' };
  const admin = new pg.Client(TEST_DB);
  let file = '';
  // pg_dump refuses a server newer than itself, so an older client (a stale install) skips rather than fails.
  let tooOld = '';

  before(async () => {
    testOnly(SOURCE);
    testOnly(SCRATCH);
    await admin.connect();
    const server = Math.floor(Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
    const client = clientMajor(pgDump as string);
    if (client < server) {
      tooOld = `pg_dump ${client || '?'} is older than the PostgreSQL ${server} server`;
      return;
    }
    await migrate();
    await save(raw({ id: JOB, url: 'https://example.com/restoretest/1', title: 'Restore Test Engineer' }));
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
  });
  after(async () => {
    await pool.query('DELETE FROM jobs WHERE id = $1', [JOB]);
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${testOnly(SCRATCH)} WITH (FORCE)`);
    await admin.end();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Restore options for the scratch database only. */
  const into = (yes: boolean) => {
    const o = restoreOptions(file, { into: SCRATCH, yes: yes ? 'true' : undefined }, env, psql, pgDump);
    testOnly(o.db);
    return o;
  };
  const scratchJob = async () => {
    const c = new pg.Client(TEST_DB.replace(/\/[^/]+$/, `/${SCRATCH}`));
    await c.connect();
    try {
      return (await c.query('SELECT id, title FROM jobs WHERE id = $1', [JOB])).rows;
    } finally {
      await c.end();
    }
  };

  it('backs up the test database and restores it into an empty scratch database; the job row survives', async (t) => {
    if (tooOld) return t.skip(tooOld);
    const o = backupOptions(env, pgDump);
    assert.equal(testOnly(o.db), SOURCE);
    const lines = await backup(o);
    file = join(dir, `${SOURCE}-${o.date}.sql.gz`);
    assert.match(lines[0], new RegExp(`${SOURCE}-${o.date}\\.sql\\.gz`));
    const logs: string[] = [];
    await restore(into(false), (l) => logs.push(l));
    assert.deepEqual(await scratchJob(), [{ id: JOB, title: 'Restore Test Engineer' }]);
    assert.match(logs.join('\n'), new RegExp(`restore: done\\. ${SCRATCH} has \\d+ table\\(s\\) and \\d+ job\\(s\\); latest migration`));
  });

  it('refuses the now non-empty scratch database without --yes; with --yes backs it up first and restores again', async (t) => {
    if (tooOld) return t.skip(tooOld);
    await assert.rejects(
      restore(into(false), () => {}),
      /has \d+ table\(s\).*\n.*Nothing was changed/,
    );
    const logs: string[] = [];
    await restore(into(true), (l) => logs.push(l));
    assert.equal(readdirSync(dir).filter((f) => f.startsWith(`${SCRATCH}-before-restore-`)).length, 1);
    assert.deepEqual(await scratchJob(), [{ id: JOB, title: 'Restore Test Engineer' }]);
    assert.match(logs.join('\n'), /restore: done\./);
  });
});
