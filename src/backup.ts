import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { posix, resolve, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { onPath } from './notify.ts';
import { ROOT } from './settings.ts';

// Daily pg_dump of the job_bot database into data/backups/<db>-YYYY-MM-DD.sql.gz, keeping the newest 14. Gzip is done
// in Node (zlib), so only pg_dump is needed, on any OS. Run by `bot backup` (and so by the daily fetch).
// The connection comes from DATABASE_URL (.env), so a database with a password works too; PGHOST, PGPORT, PGUSER and
// PGPASSWORD override its parts. Other overrides (also used by tests): JOB_BOT_BACKUP_DB, JOB_BOT_BACKUP_DIR,
// JOB_BOT_BACKUP_KEEP, JOB_BOT_BACKUP_DATE (YYYY-MM-DD, default today), JOB_BOT_PG_DUMP (the pg_dump program).

export type BackupOptions = {
  db: string;
  dir: string;
  keep: number;
  date: string;
  /** The program and any leading arguments, e.g. ['/usr/bin/pg_dump']. */
  pgDump: string[];
  host: string;
  port: string;
  user: string;
  /** Given to pg_dump as PGPASSWORD, never on its command line or in the log. */
  password?: string;
};

type Exists = (p: string) => boolean;
type List = (dir: string) => string[];
const listDir: List = (dir) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Today's local date as YYYY-MM-DD (what `date +%F` printed). */
export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Newest version first: "17.2" before "17" before "9.6". */
const byVersionDesc = (a: string, b: string) => b.localeCompare(a, 'en', { numeric: true });

/**
 * pg_dump: JOB_BOT_PG_DUMP, else PATH, else the usual install folders of this OS (DBngin, Postgres.app and Homebrew's
 * keg-only postgresql@N on macOS; the EDB installer on Windows; Debian/Ubuntu and RHEL packages on Linux). Null if none.
 */
export function findPgDump(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: Exists = existsSync,
  list: List = listDir,
): string | null {
  if (env.JOB_BOT_PG_DUMP) return env.JOB_BOT_PG_DUMP;
  const found = onPath('pg_dump', env, platform, exists);
  if (found) return found;
  const join = platform === 'win32' ? win32.join : posix.join;
  /** <parent>/<version>/<...rest>, newest version first, for each version folder that matches. */
  const versions = (parent: string, match: RegExp, ...rest: string[]) =>
    list(parent)
      .filter((d) => match.test(d))
      .sort(byVersionDesc)
      .map((d) => join(parent, d, ...rest));
  const candidates =
    platform === 'darwin'
      ? [
          ...versions('/Users/Shared/DBngin/postgresql', /^\d/, 'bin', 'pg_dump'),
          '/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump',
          ...['/opt/homebrew/opt', '/usr/local/opt'].flatMap((p) => versions(p, /^postgresql@\d/, 'bin', 'pg_dump')),
        ]
      : platform === 'win32'
        ? versions(join(env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL'), /^\d/, 'bin', 'pg_dump.exe')
        : [...versions('/usr/lib/postgresql', /^\d/, 'bin', 'pg_dump'), ...versions('/usr', /^pgsql-\d/, 'bin', 'pg_dump')];
  return candidates.find((p) => exists(p)) ?? null;
}

/** The backup settings from the environment. Throws on an invalid date or when pg_dump is missing. */
export function backupOptions(env: NodeJS.ProcessEnv = process.env, pgDump = findPgDump(env)): BackupOptions {
  const date = env.JOB_BOT_BACKUP_DATE || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`backup: JOB_BOT_BACKUP_DATE must be YYYY-MM-DD, not ${date}`);
  const keep = Number(env.JOB_BOT_BACKUP_KEEP || 14);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`backup: JOB_BOT_BACKUP_KEEP must be a whole number from 1, not ${keep}`);
  if (!pgDump) throw new Error('backup: pg_dump not found (PATH, JOB_BOT_PG_DUMP or the usual PostgreSQL install folders)');
  let url: URL | undefined;
  try {
    url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
  } catch {} // an unreadable DATABASE_URL: the defaults below
  const part = (s: string | undefined) => (s ? decodeURIComponent(s) : undefined);
  const password = env.PGPASSWORD || part(url?.password);
  return {
    db: env.JOB_BOT_BACKUP_DB || part(url?.pathname.slice(1)) || 'job_bot',
    dir: resolve(ROOT, env.JOB_BOT_BACKUP_DIR || 'data/backups'),
    keep,
    date,
    pgDump: [pgDump],
    host: env.PGHOST || url?.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
    port: env.PGPORT || url?.port || '5432',
    user: env.PGUSER || part(url?.username) || 'postgres',
    ...(password ? { password } : {}),
  };
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)}K` : `${(bytes / 1024 ** 2).toFixed(1)}M`;

/**
 * Dumps the database to <dir>/<db>-<date>.sql.gz through a temp file (a failed dump never replaces a good backup),
 * then deletes all but the newest `keep` backups of that database. Returns the lines to log; throws if pg_dump fails.
 */
export async function backup(o: BackupOptions): Promise<string[]> {
  mkdirSync(o.dir, { recursive: true });
  const out = resolve(o.dir, `${o.db}-${o.date}.sql.gz`);
  const tmp = `${out}.tmp`;
  const [cmd, ...pre] = o.pgDump;
  const child = spawn(cmd, [...pre, '-h', o.host, '-p', o.port, '-U', o.user, '--no-owner', o.db], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: o.password ? { ...process.env, PGPASSWORD: o.password } : process.env,
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((done, fail) => {
    child.on('error', fail);
    child.on('close', done);
  });
  try {
    const [, code] = await Promise.all([pipeline(child.stdout, createGzip(), createWriteStream(tmp)), exited]);
    if (code !== 0) throw new Error(`pg_dump exited ${code}`);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw new Error(`backup failed: ${(e as Error).message}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
  }
  if (stderr.trim()) process.stderr.write(stderr);
  renameSync(tmp, out);
  const lines = [`backup: ${out} (${size(statSync(out).size)})`];

  // Dated names sort chronologically; delete everything past the newest `keep`.
  const own = new RegExp(`^${o.db.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}\\.sql\\.gz$`);
  const old = readdirSync(o.dir)
    .filter((f) => own.test(f))
    .sort()
    .reverse()
    .slice(o.keep);
  for (const f of old) {
    rmSync(resolve(o.dir, f), { force: true });
    lines.push(`backup: removed ${resolve(o.dir, f)}`);
  }
  return lines;
}
