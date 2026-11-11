import { runBot } from './bot';

// The dashboard reads and writes the database directly, so after a `git pull` that adds a migration its queries can
// fail ("column ... does not exist") until some bot command has run. instrumentation.ts calls migrateOnce() when
// the server starts. It runs `bot migrate` in a child process: the bot's own runner (src/migrate.ts, whose advisory
// lock serialises it with any bot command migrating at the same time), with no bot code bundled into the dashboard.
// The child inherits this process's DATABASE_URL (web/.env.local), so it migrates the database the dashboard uses.

type Log = Pick<Console, 'log' | 'error'>;
export type MigrateDeps = { run?: (args: string[]) => Promise<string>; log?: Log };

/** Runs `bot migrate` and logs what it applied. Never throws: a failure is logged, and the dashboard still starts. */
export async function applyMigrations({ run = (args) => runBot(args, 120_000), log = console }: MigrateDeps = {}): Promise<boolean> {
  try {
    const out = (await run(['migrate'])).trim();
    if (out) log.log(`[talaash] ${out}`);
    return true;
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const why = (err.stderr?.trim() || err.message).slice(0, 2000);
    log.error(
      `[talaash] Could not apply the database migrations: ${why}\n` +
        '[talaash] Pages that need a new column may fail until this works. Run "npm run bot -- migrate" in the Talaash folder to see why.',
    );
    return false;
  }
}

const g = globalThis as unknown as { jobBotMigrated?: Promise<boolean> };

/** applyMigrations once per server process (a dev-server reload keeps the first run's result). */
export function migrateOnce(deps?: MigrateDeps): Promise<boolean> {
  g.jobBotMigrated ??= applyMigrations(deps);
  return g.jobBotMigrated;
}
