import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { BOT_ROOT, runBot } from '@/lib/bot';

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
afterEach(() => { vi.unstubAllEnvs(); });
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

describe('runBot', () => {
  it('runs the CLI and returns its output', async () => {
    withBotDb();
    await db.query(`INSERT INTO jobs (id, source, company, title, country, url, status, score)
      VALUES ('webtest:stats', 'greenhouse', 'Acme', 'Engineer', 'AE', 'https://example.com/s', 'interview', 50)`);
    expect(await runBot(['stats'])).toMatch(/^interview\s+AE\s+\d+$/m);
  }, 30_000);

  it('prints the usage for an unknown command', async () => {
    withBotDb();
    expect(await runBot(['no-such-command'])).toContain('Commands:');
  }, 30_000);

  it('passes arguments literally, without a shell', async () => {
    withBotDb();
    await db.query(`INSERT INTO jobs (id, source, company, title, country, url, status, score)
      VALUES ($1, 'greenhouse', 'Acme', 'Literal Args Engineer', 'AE', 'https://example.com/l', 'new', 50)`, [ID]);
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
