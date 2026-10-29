import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Versioned schema migrations, applied on every CLI start (and by the backend and dashboard tests).
//
// Convention for src/migrations/:
// - One file per change, named NNN_name.sql (001_baseline.sql, 002_follow_ups.sql, ...). Files run in name order.
// - Each file runs once, inside its own transaction, and is then recorded in `schema_migrations`.
//   A file that fails is rolled back completely and is retried on the next start.
// - Write them idempotent where possible (IF NOT EXISTS), so a database that already has the change still upgrades.
// - Never edit a file after it is committed: databases that already ran it would not see the edit. Add a new file.
// - Nothing that cannot run in a transaction (e.g. CREATE INDEX CONCURRENTLY).
//
// This file imports nothing from the bot, so the dashboard tests (web/tests/helpers/db.ts) can use it too.

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Any client/pool with pg's query API (the bot and the dashboard each have their own `pg`).
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; release(): void };
export type MigrationDb = { connect(): Promise<Client> };

/** The migration files in `dir`, in the order they run. */
export function migrationFiles(dir = MIGRATIONS_DIR): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const bad = files.find((f) => !/^\d{3}_[a-z0-9_]+\.sql$/.test(f));
  if (bad) throw new Error(`Bad migration file name ${bad}: use NNN_name.sql`);
  return files;
}

/**
 * Applies every migration in `dir` that `schema_migrations` does not list yet, and returns their versions
 * (file names without .sql). A session advisory lock serialises concurrent starts.
 */
export async function runMigrations(db: MigrationDb, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = migrationFiles(dir);
  const client = await db.connect();
  const applied: string[] = [];
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('job_bot:migrations'))`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((r: { version: string }) => r.version));
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (done.has(version)) continue;
      try {
        await client.query('BEGIN');
        await client.query(readFileSync(join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      applied.push(version);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('job_bot:migrations'))`).catch(() => {});
    client.release();
  }
  return applied;
}
