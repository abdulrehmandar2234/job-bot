import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_ROOT } from '@/lib/bot';
import { pool } from '@/lib/db';
import { applyMigrations, migrateOnce } from '@/lib/migrate';

// The dashboard applies pending migrations once at startup (instrumentation.ts -> lib/migrate.ts -> `bot migrate`).

const g = globalThis as unknown as { jobBotMigrated?: Promise<boolean> };
const fakeLog = () => ({ log: vi.fn(), error: vi.fn() });

beforeEach(() => {
  delete g.jobBotMigrated;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/migrate');
  vi.doUnmock('@/lib/settings');
  vi.resetModules();
});
afterAll(() => pool.end());

describe('applyMigrations', () => {
  it('runs `bot migrate` and logs what it applied', async () => {
    const run = vi.fn(async () => 'Applied 1 migration(s): 027_new_column\n');
    const log = fakeLog();
    expect(await applyMigrations({ run, log })).toBe(true);
    expect(run).toHaveBeenCalledWith(['migrate']);
    expect(log.log).toHaveBeenCalledWith('[talaash] Applied 1 migration(s): 027_new_column');
    expect(log.error).not.toHaveBeenCalled();
  });

  it('logs a failure clearly, with the bot error, and never throws', async () => {
    const run = vi.fn(async () => {
      throw Object.assign(new Error('Command failed'), { stderr: 'Error: connect ECONNREFUSED 127.0.0.1:5432\n' });
    });
    const log = fakeLog();
    expect(await applyMigrations({ run, log })).toBe(false);
    const [message] = log.error.mock.calls[0];
    expect(message).toMatch(/^\[talaash\] Could not apply the database migrations: Error: connect ECONNREFUSED 127\.0\.0\.1:5432\n/);
    expect(message).toMatch(/npm run bot -- migrate/);
  });

  it('applies the real migrations through the bot CLI on the test database', { timeout: 60_000 }, async () => {
    const log = fakeLog();
    // The child inherits DATABASE_URL (this test database), which wins over the bot's .env.
    expect(await applyMigrations({ log })).toBe(true);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.log.mock.calls[0][0]).toMatch(/^\[talaash\] (Database is up to date\.|Applied \d+ migration)/);
    const files = readdirSync(join(BOT_ROOT, 'src', 'migrations')).filter((f) => f.endsWith('.sql'));
    const { rows } = await pool.query<{ version: string }>('SELECT version FROM schema_migrations');
    expect(rows.map((r) => r.version).sort()).toEqual(files.map((f) => f.replace(/\.sql$/, '')).sort());
  });
});

describe('migrateOnce', () => {
  it('runs the migrations once per process', async () => {
    const run = vi.fn(async () => 'Database is up to date.');
    const log = fakeLog();
    await Promise.all([migrateOnce({ run, log }), migrateOnce({ run, log })]);
    await migrateOnce({ run, log });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('instrumentation register', () => {
  const load = async () => {
    const migrateOnce = vi.fn(async () => true);
    const ensureConfigFile = vi.fn(() => false);
    vi.doMock('@/lib/migrate', () => ({ migrateOnce }));
    vi.doMock('@/lib/settings', async (orig) => ({ ...(await orig<typeof import('@/lib/settings')>()), ensureConfigFile }));
    const { register } = await import('@/instrumentation');
    return { register, migrateOnce, ensureConfigFile };
  };

  it('creates config.json on a fresh clone and migrates, in the Node.js runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    const { register, migrateOnce, ensureConfigFile } = await load();
    await register();
    expect(ensureConfigFile).toHaveBeenCalledTimes(1);
    expect(migrateOnce).toHaveBeenCalledTimes(1);
  });

  it('does nothing in the edge runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register, migrateOnce, ensureConfigFile } = await load();
    await register();
    expect(ensureConfigFile).not.toHaveBeenCalled();
    expect(migrateOnce).not.toHaveBeenCalled();
  });
});
