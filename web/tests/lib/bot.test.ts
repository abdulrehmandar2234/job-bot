import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOT_ROOT, botDataDir, runBot, spawnBot } from '@/lib/bot';

// The CLI gets the bot's own test database (job_bot_test[_name] -> job_bot_test_bot[_name]), never job_bot.
const BOT_DB_URL = process.env.DATABASE_URL!.replace(/\/job_bot_test(_[a-z0-9]+)?$/, '/job_bot_test_bot$1');
const ID = 'webtest:; rm -rf x $(touch pwned)';

const withBotDb = () => {
  vi.stubEnv('DATABASE_URL', BOT_DB_URL);
  vi.stubEnv('JOB_BOT_CLAUDE', 'tests/fixtures/fake-claude.mjs');
};

let db: pg.Pool;
beforeAll(async () => {
  expect(BOT_DB_URL).toMatch(/\/job_bot_test_bot(_[a-z0-9]+)?$/);
  withBotDb();
  await runBot(['stats']); // applies the schema to the bot's test database
  vi.unstubAllEnvs();
  db = new pg.Pool({ connectionString: BOT_DB_URL, max: 1 });
}, 30_000);
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db?.query(`DELETE FROM jobs WHERE id LIKE 'webtest:%'`);
  await db?.end();
});

describe('BOT_ROOT', () => {
  it('is the repo root above web/ when vitest runs from web/', () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    expect(process.cwd()).toBe(join(repoRoot, 'web'));
    expect(BOT_ROOT).toBe(repoRoot);
    expect(existsSync(join(BOT_ROOT, 'src', 'cli.ts'))).toBe(true);
  });
});

describe('botDataDir', () => {
  it('is JOB_BOT_DATA_DIR (a temp dir in tests, web/tests/setup.ts), read on every call, else BOT_ROOT/data', () => {
    expect(botDataDir()).toBe(process.env.JOB_BOT_DATA_DIR);
    expect(botDataDir()).not.toBe(join(BOT_ROOT, 'data'));
    vi.stubEnv('JOB_BOT_DATA_DIR', '');
    expect(botDataDir()).toBe(join(BOT_ROOT, 'data'));
  });
});

describe('runBot', () => {
  it('runs the CLI and returns its output', async () => {
    withBotDb();
    await db.query(`INSERT INTO jobs (id, source, company, title, country, url, status, score)
      VALUES ('webtest:stats', 'greenhouse', 'Acme', 'Engineer', 'AE', 'https://example.com/s', 'interview', 50)`);
    expect(await runBot(['stats'])).toMatch(/^interview\s+AE\s+\d+$/m);
  }, 30_000);

  it('fails on an unknown command, naming it, and prints the help', async () => {
    withBotDb();
    await expect(runBot(['no-such-command'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Unknown command: no-such-command'),
      stdout: expect.stringContaining('Commands:'),
    });
  }, 30_000);

  it('passes arguments literally, without a shell', async () => {
    withBotDb();
    await db.query(
      `INSERT INTO jobs (id, source, company, title, country, url, status, score)
      VALUES ($1, 'greenhouse', 'Acme', 'Literal Args Engineer', 'AE', 'https://example.com/l', 'new', 50)`,
      [ID],
    );
    const out = await runBot(['show', ID]);
    expect(out).toContain('Literal Args Engineer');
    expect(existsSync(join(BOT_ROOT, 'pwned'))).toBe(false);
  }, 30_000);

  it('rejects when the CLI exits non-zero', async () => {
    vi.stubEnv('DATABASE_URL', BOT_DB_URL + '_missing');
    await expect(runBot(['stats'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('job_bot_test_bot') });
  }, 30_000);

  it('rejects and kills the CLI when it runs past the timeout', async () => {
    withBotDb();
    await expect(runBot(['stats'], 1)).rejects.toMatchObject({ killed: true, signal: 'SIGTERM' });
  }, 30_000);
});

describe('spawnBot', () => {
  /** Waits until the task leaves queued/running (the detached worker is not awaited). */
  async function settle(id: number) {
    for (let i = 0; i < 150; i++) {
      const {
        rows: [t],
      } = await db.query('SELECT status, output, error FROM tasks WHERE id = $1', [id]);
      if (t.status === 'done' || t.status === 'failed') return t;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`task ${id} did not finish`);
  }

  it('starts a detached task:run worker that runs the task and logs to logs/tasks.log in the data folder', async () => {
    withBotDb();
    const review = { score: 77, verdict: 'good', summary: 'Spawned', reasons: [], gaps: [], red_flags: [] };
    vi.stubEnv('FAKE_CLAUDE_OUT', JSON.stringify(review));
    await db.query(`INSERT INTO jobs (id, source, company, title, country, url, status, score)
      VALUES ('webtest:spawn', 'greenhouse', 'Acme', 'Spawn Engineer', 'AE', 'https://example.com/sp', 'new', 50)`);
    const {
      rows: [{ id }],
    } = await db.query(`INSERT INTO tasks (kind, job_id) VALUES ('ai_review', 'webtest:spawn') RETURNING id`);

    const started = Date.now();
    spawnBot(['task:run', String(id)]);
    expect(Date.now() - started).toBeLessThan(1000); // returns without waiting for the worker

    const t = await settle(id);
    expect(t).toMatchObject({ status: 'done', error: null });
    expect(t.output).toMatch(/77 good\s+Acme — Spawn Engineer/);
    const {
      rows: [job],
    } = await db.query(`SELECT ai_score, ai_summary FROM jobs WHERE id = 'webtest:spawn'`);
    expect(job).toEqual({ ai_score: 77, ai_summary: 'Spawned' });
    expect(readFileSync(join(botDataDir(), 'logs', 'tasks.log'), 'utf8')).toContain(`task ${id}: done`);
    // Never the real data/logs/tasks.log.
    const real = join(BOT_ROOT, 'data', 'logs', 'tasks.log');
    expect(existsSync(real) ? readFileSync(real, 'utf8') : '').not.toContain(`task ${id}: `);
  }, 30_000);
});
