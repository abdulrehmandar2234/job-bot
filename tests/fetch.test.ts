import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch } from './helpers.ts'; // first: it points the bot at a temp config before src/ loads one
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

  // A settings problem scoring hits (unknown stack, missing master CV) would fail every posting alike. It must stop the
  // fetch once, as the fetch's own error and a rejected promise (non-zero exit), not hide as "N of M postings not saved"
  // per source while the run looks fine. Each case uses its own board tokens, so no earlier run's rows interfere.
  const posting = (id: number) => ({
    id,
    title: 'Senior Backend Engineer',
    location: { name: 'Dubai, UAE' },
    absolute_url: `https://x/${id}`,
    content: 'Node, TypeScript, PostgreSQL',
    first_published: new Date().toISOString(),
  });
  const stopsOnce = async (token: string, pattern: RegExp, setUp: () => () => void) => {
    await pool.query('TRUNCATE fetch_runs');
    const log = quiet();
    noSources();
    config.companies = [
      { name: 'One', ats: 'greenhouse', token: `${token}a` },
      { name: 'Two', ats: 'greenhouse', token: `${token}b` },
    ];
    const net = mockFetch({
      [`boards/${token}a/jobs`]: { jobs: [posting(1), posting(2), posting(3)] },
      [`boards/${token}b/jobs`]: { jobs: [posting(4)] },
    });
    const undo = setUp();
    try {
      await assert.rejects(fetch([], {}), pattern);
    } finally {
      undo();
      net.restore();
      restore();
      log.mock.restore();
    }
    const run = await lastRun();
    assert.ok(run.finished_at, 'finished_at is stamped');
    assert.equal(run.errors.length, 1, JSON.stringify(run.errors));
    assert.equal(run.errors[0].company, 'fetch');
    assert.match(run.errors[0].error, pattern);
    const { rows } = await pool.query('SELECT id FROM jobs WHERE id LIKE $1', [`greenhouse:${token}%`]);
    assert.deepEqual(rows, []);
  };

  it('stops once on an unknown stack id instead of failing every posting', async () => {
    await stopsOnce('cfgstack', /unknown stack preset "pyhton"/, () => {
      const was = config.stacks;
      config.stacks = ['pyhton']; // in place: config.json itself is checked when it loads (tests/config.test.ts)
      return () => {
        if (was === undefined) delete config.stacks;
        else config.stacks = was;
      };
    });
  });

  it('stops once when the master CV is missing', async () => {
    await stopsOnce('cfgcv', /Cannot read the master CV/, () => {
      const was = { master: process.env.JOB_BOT_MASTER, stacks: config.stacks };
      process.env.JOB_BOT_MASTER = join(mkdtempSync(join(tmpdir(), 'job-bot-fetch-cv-')), 'missing.json');
      config.stacks = ['python']; // a new stacks value, so the cached skill list is built again (and reads the CV)
      return () => {
        if (was.master === undefined) delete process.env.JOB_BOT_MASTER;
        else process.env.JOB_BOT_MASTER = was.master;
        if (was.stacks === undefined) delete config.stacks;
        else config.stacks = was.stacks;
      };
    });
  });
});
