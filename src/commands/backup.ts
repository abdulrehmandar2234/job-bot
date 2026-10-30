import { backup as runBackup, backupOptions } from '../backup.ts';

/** backup: pg_dump of the database into data/backups (keeps 14). Needs no connection of its own, only pg_dump. */
export async function backup() {
  try {
    for (const line of await runBackup(backupOptions())) console.log(line);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}
