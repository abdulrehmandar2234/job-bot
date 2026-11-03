import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.ts'; // first: it points the bot at a temp config before src/ loads one
import { fetch } from '../src/commands/fetch.ts';
import { config } from '../src/config.ts';
import { migrate, pool } from '../src/db.ts';

// The fetch_runs row: finished_at must be stamped even when the fetch itself blows up, or the dashboard shows a
// fetch that never ends. No network: every source is turned off, and the fatal error fires before any is loaded.

before(migrate);
after(() => pool.end());

describe('fetch run row', () => {
  const saved = { companies: config.companies, remote: config.remote.enabled, linkedin: config.linkedin.enabled };
  const quiet = () => mock.method(console, 'log', () => {});
  const noSources = () => {
    config.companies = [];
    config.remote.enabled = false;
    config.linkedin.enabled = false;
  };
  const restore = () => {
    config.companies = saved.companies;
    config.remote.enabled = saved.remote;
    config.linkedin.enabled = saved.linkedin;
  };
  const lastRun = async () =>
    (
      await pool.query<{ finished_at: Date | null; errors: { company: string; error: string }[] }>(
        'SELECT finished_at, errors FROM fetch_runs ORDER BY id DESC LIMIT 1',
      )
    ).rows[0];

  it('stamps finished_at on a normal run', async () => {
    await pool.query('TRUNCATE fetch_runs');
    const log = quiet();
    noSources();
    try {
      await fetch([], {});
    } finally {
      restore();
      log.mock.restore();
    }
    const run = await lastRun();
    assert.ok(run.finished_at, 'finished_at is stamped');
    assert.deepEqual(run.errors, []);
  });

  it('stamps finished_at and records the error when the fetch itself throws', async () => {
    await pool.query('TRUNCATE fetch_runs');
    const log = quiet();
    noSources();
    config.remote.enabled = true; // so the boards are read — and reading them is made to explode
    const boards = config.remote.boards;
    Object.defineProperty(config.remote, 'boards', {
      configurable: true,
      get() {
        throw new Error('boards exploded');
      },
    });
    try {
      await assert.rejects(fetch([], {}), /boards exploded/);
    } finally {
      Object.defineProperty(config.remote, 'boards', { configurable: true, enumerable: true, writable: true, value: boards });
      restore();
      log.mock.restore();
    }
    const run = await lastRun();
    assert.ok(run.finished_at, 'finished_at is stamped even when the fetch throws');
    assert.deepEqual(run.errors, [{ company: 'fetch', error: 'boards exploded' }]);
  });
});
