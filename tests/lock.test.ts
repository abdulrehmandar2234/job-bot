import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type pg from 'pg';
import { TEST_DB } from './helpers.ts';
import { migrate, pool, withLock } from '../src/db.ts';
import { path } from '../src/config.ts';

// One fetch / bulk check:open at a time (withLock in src/db.ts), held across processes by a Postgres advisory lock.
const FAKE_FETCH = pathToFileURL(join(import.meta.dirname, 'fixtures', 'fake-fetch.mjs')).href;
const run = promisify(execFile);

async function bot(args: string[]) {
  const { stdout } = await run(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], {
    cwd: path(),
    env: { ...process.env, DATABASE_URL: TEST_DB, NODE_OPTIONS: `--import=${FAKE_FETCH}`, FAKE_FETCH: '{}' },
    timeout: 60_000,
  });
  return stdout;
}

/** Holds the lock `name` from the test's own connection, as another running fetch would. */
async function hold(name: string) {
  const client: pg.PoolClient = await pool.connect();
  await client.query(`SELECT pg_advisory_lock(hashtext('job_bot:' || $1))`, [name]);
  return async () => {
    await client.query(`SELECT pg_advisory_unlock(hashtext('job_bot:' || $1))`, [name]);
    client.release();
  };
}

const heldLocks = async () =>
  (
    await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    )
  ).rows[0].n;
const fetchRuns = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM fetch_runs')).rows[0].n;

before(migrate);
beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
after(() => pool.end());

describe('withLock', () => {
  it('runs fn and releases the lock afterwards', async () => {
    let ran = false;
    assert.equal(
      await withLock('t1', async () => {
        ran = true;
        assert.equal(await heldLocks(), 1);
      }),
      true,
    );
    assert.ok(ran);
    assert.equal(await heldLocks(), 0);
  });

  it('skips fn while another session holds the lock', async () => {
    const release = await hold('t2');
    try {
      let ran = false;
      assert.equal(
        await withLock('t2', async () => {
          ran = true;
        }),
        false,
      );
      assert.equal(ran, false);
      // A different name is a different lock.
      assert.equal(await withLock('t3', async () => {}), true);
    } finally {
      await release();
    }
  });

  it('releases the lock when fn throws', async () => {
    await assert.rejects(
      withLock('t4', async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal(await heldLocks(), 0);
    assert.equal(await withLock('t4', async () => {}), true);
  });
});

describe('CLI', () => {
  it('fetch skips, exit 0, while another fetch holds the lock', async () => {
    const release = await hold('fetch');
    try {
      const out = await bot(['fetch', '--company', 'no-such-company']);
      assert.match(out, /A fetch is already running; skipping\./);
      assert.equal(await fetchRuns(), 0);
    } finally {
      await release();
    }
    const out = await bot(['fetch', '--company', 'no-such-company']);
    assert.doesNotMatch(out, /already running/);
    assert.match(out, /0 postings checked, 0 new/);
    assert.equal(await fetchRuns(), 1);
  });

  it('a bulk check:open skips while another holds the lock; checking named jobs never does', async () => {
    const release = await hold('check:open');
    try {
      assert.match(await bot(['check:open']), /A check:open is already running; skipping\./);
      const named = await bot(['check:open', 'nope:1']);
      assert.doesNotMatch(named, /already running/);
      assert.match(named, /Not found: nope:1/);
    } finally {
      await release();
    }
    const out = await bot(['check:open']);
    assert.doesNotMatch(out, /already running/);
    assert.match(out, /No postings to check\./);
  });
});
