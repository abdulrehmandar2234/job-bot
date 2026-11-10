import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, posix, resolve, win32 } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip, gunzip } from 'node:zlib';
import { onPath } from './notify.ts';
import { ROOT } from './settings.ts';

// Daily pg_dump of the job_bot database into data/backups/<db>-YYYY-MM-DD.sql.gz, keeping the newest 14. Gzip is done
// in Node (zlib), so only pg_dump is needed, on any OS. Run by `bot backup` (and so by the daily fetch).
// The connection comes from DATABASE_URL (.env), so a database with a password works too; PGHOST, PGPORT, PGUSER and
// PGPASSWORD override its parts. Other overrides (also used by tests): JOB_BOT_BACKUP_DB, JOB_BOT_BACKUP_DIR,
// JOB_BOT_BACKUP_KEEP, JOB_BOT_BACKUP_DATE (YYYY-MM-DD, default today), JOB_BOT_PG_DUMP (the pg_dump program).
//
// `bot restore <file>` loads such a backup back with psql (JOB_BOT_PSQL, else found like pg_dump): see restore().

/** Where the database is: DATABASE_URL, with PGHOST, PGPORT, PGUSER, PGPASSWORD and JOB_BOT_BACKUP_DB winning. */
export type Connection = {
  db: string;
  host: string;
  port: string;
  user: string;
  /** Given to pg_dump and psql as PGPASSWORD, never on their command line or in the log. */
  password?: string;
};

export type BackupOptions = Connection & {
  dir: string;
  keep: number;
  date: string;
  /** The program and any leading arguments, e.g. ['/usr/bin/pg_dump']. */
  pgDump: string[];
  /** A file name instead of <db>-<date>.sql.gz (restore's safety copy). Such a file is not counted in the `keep`. */
  file?: string;
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
 * A PostgreSQL program: `override` (JOB_BOT_PG_DUMP, JOB_BOT_PSQL), else PATH, else the usual install folders of this
 * OS (DBngin, Postgres.app and Homebrew's keg-only postgresql@N on macOS; the EDB installer on Windows; Debian/Ubuntu
 * and RHEL packages on Linux). Null if none.
 */
function findPgProgram(
  name: 'pg_dump' | 'psql',
  override: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exists: Exists,
  list: List,
): string | null {
  if (override) return override;
  const found = onPath(name, env, platform, exists);
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
          ...versions('/Users/Shared/DBngin/postgresql', /^\d/, 'bin', name),
          `/Applications/Postgres.app/Contents/Versions/latest/bin/${name}`,
          ...['/opt/homebrew/opt', '/usr/local/opt'].flatMap((p) => versions(p, /^postgresql@\d/, 'bin', name)),
        ]
      : platform === 'win32'
        ? versions(join(env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL'), /^\d/, 'bin', `${name}.exe`)
        : [...versions('/usr/lib/postgresql', /^\d/, 'bin', name), ...versions('/usr', /^pgsql-\d/, 'bin', name)];
  return candidates.find((p) => exists(p)) ?? null;
}

/** pg_dump: JOB_BOT_PG_DUMP, else PATH, else the usual PostgreSQL install folders of this OS. Null if none. */
export const findPgDump = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: Exists = existsSync,
  list: List = listDir,
) => findPgProgram('pg_dump', env.JOB_BOT_PG_DUMP, env, platform, exists, list);

/** psql (for restore): JOB_BOT_PSQL, else PATH, else the same install folders as pg_dump. Null if none. */
export const findPsql = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: Exists = existsSync,
  list: List = listDir,
) => findPgProgram('psql', env.JOB_BOT_PSQL, env, platform, exists, list);

/** The database connection: DATABASE_URL's parts, with the PG* variables and JOB_BOT_BACKUP_DB winning. */
export function connection(env: NodeJS.ProcessEnv = process.env): Connection {
  let url: URL | undefined;
  try {
    url = env.DATABASE_URL ? new URL(env.DATABASE_URL) : undefined;
  } catch {} // an unreadable DATABASE_URL: the defaults below
  const part = (s: string | undefined) => (s ? decodeURIComponent(s) : undefined);
  const password = env.PGPASSWORD || part(url?.password);
  return {
    db: env.JOB_BOT_BACKUP_DB || part(url?.pathname.slice(1)) || 'job_bot',
    host: env.PGHOST || url?.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1',
    port: env.PGPORT || url?.port || '5432',
    user: env.PGUSER || part(url?.username) || 'postgres',
    ...(password ? { password } : {}),
  };
}

/** JOB_BOT_BACKUP_DATE, else today. Throws unless it is YYYY-MM-DD (it becomes part of a file name). */
function backupDate(env: NodeJS.ProcessEnv): string {
  const date = env.JOB_BOT_BACKUP_DATE || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`backup: JOB_BOT_BACKUP_DATE must be YYYY-MM-DD, not ${date}`);
  return date;
}

// JOB_BOT_BACKUP_DIR wins; otherwise <data dir>/backups (JOB_BOT_DATA_DIR, else data/ in the bot's folder).
const backupDir = (env: NodeJS.ProcessEnv) =>
  resolve(ROOT, env.JOB_BOT_BACKUP_DIR || join(env.JOB_BOT_DATA_DIR || join(ROOT, 'data'), 'backups'));

/** The backup settings from the environment. Throws on an invalid date or when pg_dump is missing. */
export function backupOptions(env: NodeJS.ProcessEnv = process.env, pgDump = findPgDump(env)): BackupOptions {
  const date = backupDate(env);
  const keep = Number(env.JOB_BOT_BACKUP_KEEP || 14);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`backup: JOB_BOT_BACKUP_KEEP must be a whole number from 1, not ${keep}`);
  if (!pgDump) throw new Error('backup: pg_dump not found (PATH, JOB_BOT_PG_DUMP or the usual PostgreSQL install folders)');
  return { ...connection(env), dir: backupDir(env), keep, date, pgDump: [pgDump] };
}

const size = (bytes: number) =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)}K` : `${(bytes / 1024 ** 2).toFixed(1)}M`;

/**
 * Dumps the database to <dir>/<db>-<date>.sql.gz through a temp file (a failed dump never replaces a good backup),
 * then deletes all but the newest `keep` backups of that database. Returns the lines to log; throws if pg_dump fails.
 * With `file`, it writes that name instead and deletes nothing.
 */
export async function backup(o: BackupOptions): Promise<string[]> {
  mkdirSync(o.dir, { recursive: true });
  const out = resolve(o.dir, o.file ?? `${o.db}-${o.date}.sql.gz`);
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
  if (o.file) return lines; // a one-off copy: the dated backups stay as they are

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

// ---- Restore ----

export type RestoreOptions = Connection & {
  /** The backup to load: a .sql.gz from `bot backup`, or the same SQL unzipped. */
  file: string;
  /** Replace a database that already has tables (after a fresh backup of it). */
  yes: boolean;
  /** The psql program and any leading arguments. */
  psql: string[];
  /** For the safety backup of a target that has tables: the backup folder, today's date and pg_dump (null: none). */
  dir: string;
  date: string;
  pgDump: string[] | null;
};

/** The database names restore accepts (it becomes a psql argument and part of the safety backup's file name). */
const DB_NAME = /^[\w$-]{1,63}$/;

/**
 * The restore settings: the file, the target (--into, else the database `bot backup` dumps) and the programs.
 * Throws when the file or psql is missing or the target is not a plain database name.
 */
export function restoreOptions(
  file: string | undefined,
  flags: { into?: string | undefined; yes?: string | undefined },
  env: NodeJS.ProcessEnv = process.env,
  psql = findPsql(env),
  pgDump = findPgDump(env),
): RestoreOptions {
  if (!file) throw new Error('restore: name the backup file, e.g. npm run bot -- restore data/backups/job_bot-2026-01-31.sql.gz');
  if (flags.into === 'true') throw new Error('restore: --into needs a database name');
  const conn = connection(env);
  const db = flags.into ?? conn.db;
  if (!DB_NAME.test(db)) throw new Error(`restore: "${db}" is not a database name restore accepts (letters, digits, _, $ and -)`);
  if (!psql) throw new Error('restore: psql not found (PATH, JOB_BOT_PSQL or the usual PostgreSQL install folders)');
  return {
    ...conn,
    db,
    file: resolve(file),
    yes: flags.yes === 'true',
    psql: [psql],
    dir: backupDir(env),
    date: backupDate(env),
    pgDump: pgDump ? [pgDump] : null,
  };
}

/** pg_dump writes this comment at the very end of a plain dump, so its absence means a cut-short file. */
const DUMP_END = '-- PostgreSQL database dump complete';
/** The user's tables, in every schema but the system ones. */
const TABLES_SQL =
  "SELECT schemaname || '.' || tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1";
/** Run before the dump, in the same transaction: a plain dump's CREATE statements fail on objects that exist. */
const RESET_SQL = 'SET client_min_messages = warning;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n';

/** Runs psql against the target database, with `input` on stdin; returns stdout, throws with stderr on failure. */
function runPsql(o: RestoreOptions, args: string[], input: Buffer | string = ''): Promise<string> {
  const [cmd, ...pre] = o.psql;
  // -X: no ~/.psqlrc; -w: never prompt for a password (it would hang a script); -q: no command tags.
  const child = spawn(cmd, [...pre, '-X', '-w', '-q', '-h', o.host, '-p', o.port, '-U', o.user, '-d', o.db, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: o.password ? { ...process.env, PGPASSWORD: o.password } : process.env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.on('error', () => {}); // psql quit early (EPIPE): its exit code and stderr say why
  child.stdin.end(input);
  return new Promise((done, fail) => {
    child.on('error', (e) => fail(new Error(`psql could not start: ${e.message}`)));
    child.on('close', (code) =>
      code === 0 ? done(stdout) : fail(new Error(`psql exited ${code}${stderr.trim() ? `\n${stderr.trim()}` : ''}`)),
    );
  });
}

/** One value per line, from a psql -tA query. */
const query = async (o: RestoreOptions, sql: string) =>
  (await runPsql(o, ['-t', '-A', '-c', sql]))
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** The date in a backup's name (<db>-YYYY-MM-DD.sql.gz), else the file's own date. */
const backupDay = (file: string) => basename(file).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? localDate(statSync(file).mtime);

const hhmmss = (d = new Date()) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');

/**
 * Loads a `bot backup` file into the target database with psql, in one transaction (ON_ERROR_STOP, so any error rolls
 * everything back): drops and recreates the `public` schema, then runs the dump. A target that already has tables is
 * only replaced with `yes`, and then only after a fresh backup of it (<db>-before-restore-<date>-<time>.sql.gz).
 * Logs progress through `log`; throws, having changed nothing, on a bad file, a refusal or a failed load.
 */
export async function restore(o: RestoreOptions, log: (line: string) => void = console.log): Promise<void> {
  // 1. The file, before any database work: readable, valid gzip (or plain SQL) and a complete pg_dump.
  let raw: Buffer;
  try {
    raw = await readFile(o.file);
  } catch (e) {
    throw new Error(`restore: cannot read ${o.file} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  let sql = raw;
  if (raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      sql = await promisify(gunzip)(raw);
    } catch (e) {
      throw new Error(`restore: ${o.file} is a damaged gzip file (${(e as Error).message}). Nothing was changed.`);
    }
  }
  if (!sql.includes(DUMP_END))
    throw new Error(`restore: ${o.file} is not a complete pg_dump file (its last line, "${DUMP_END}", is missing). Nothing was changed.`);
  const about = `${o.file} (backup of ${backupDay(o.file)}, ${size(raw.length)})`;
  const where = `database ${o.db} on ${o.host}:${o.port}`;

  // 2. What the target holds now.
  let tables: string[];
  try {
    tables = await query(o, TABLES_SQL);
  } catch (e) {
    const msg = (e as Error).message;
    const create = /does not exist/.test(msg)
      ? `\nCreate it first (createdb -h ${o.host} -p ${o.port} -U ${o.user} ${o.db}), then run restore again.`
      : '';
    throw new Error(`restore: cannot open ${where}: ${msg}${create}`);
  }
  if (tables.length && !o.yes)
    throw new Error(
      [
        `restore: ${where} has ${tables.length} table(s) (${tables.slice(0, 6).join(', ')}${tables.length > 6 ? ', ...' : ''}).`,
        `Restoring ${about} replaces all of its data. Nothing was changed.`,
        `Stop the dashboard, then run again with --yes: a backup of the current ${o.db} is taken first.`,
      ].join('\n'),
    );
  if (tables.length) {
    if (!o.pgDump)
      throw new Error(
        `restore: pg_dump not found, so the current ${o.db} cannot be backed up first (JOB_BOT_PG_DUMP). Nothing was changed.`,
      );
    const lines = await backup({
      ...o,
      keep: 1, // unused: a `file` backup deletes nothing
      pgDump: o.pgDump,
      file: `${o.db}-before-restore-${o.date}-${hhmmss()}.sql.gz`,
    });
    for (const line of lines) log(line);
    log(`restore: the current ${o.db} is saved there; restore that file to undo this restore.`);
  }

  // 3. The load: one transaction, stopped (and rolled back) by the first error.
  log(`restore: loading ${about} into ${where} ...`);
  try {
    await runPsql(o, ['-v', 'ON_ERROR_STOP=1', '--single-transaction'], Buffer.concat([Buffer.from(RESET_SQL), sql]));
  } catch (e) {
    throw new Error(`restore failed: ${(e as Error).message}\nNothing was changed: the restore runs in one transaction.`);
  }

  // 4. A short summary. The restore itself is done, so a failed count only shortens it.
  try {
    const now = await query(o, TABLES_SQL);
    const has = (t: string) => now.includes(`public.${t}`);
    const jobs = has('jobs') ? (await query(o, 'SELECT count(*) FROM public.jobs'))[0] : undefined;
    const latest = has('schema_migrations') ? (await query(o, 'SELECT max(version) FROM public.schema_migrations'))[0] : undefined;
    log(
      `restore: done. ${o.db} has ${now.length} table(s)${jobs === undefined ? '' : ` and ${jobs} job(s)`}` +
        `${latest ? `; latest migration in the backup: ${latest}` : ''}.`,
    );
  } catch {
    log(`restore: done (${o.db} restored; counting its tables failed).`);
  }
  log('restore: migrations newer than the backup apply on the next bot command (or when the dashboard starts).');
}
