import { backup as runBackup, backupOptions, restore as runRestore, restoreOptions } from '../backup.ts';
import type { Flags } from './shared.ts';

/** backup: pg_dump of the database into data/backups (keeps 14). Needs no connection of its own, only pg_dump. */
export async function backup() {
  try {
    for (const line of await runBackup(backupOptions())) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

/**
 * restore <file> [--into <database>] [--yes]: loads a `bot backup` file with psql. Manages its own connection (no
 * migrations first: the next command applies those newer than the backup). Exits 1 on a refusal or any failure.
 */
export async function restore(args: string[], flags: Flags) {
  // `--yes <file>` reads the file as the flag's value; it is still the file.
  const file = args[0] ?? (flags.yes && flags.yes !== 'true' ? flags.yes : undefined);
  const yes = flags.yes !== undefined ? 'true' : undefined;
  try {
    await runRestore(restoreOptions(file, { into: flags.into, yes }));
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
