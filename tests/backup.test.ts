import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { backup, backupOptions, findPgDump, localDate, type BackupOptions } from '../src/backup.ts';

// The backup (src/backup.ts, `bot backup`) runs against a fake pg_dump and a temp output dir, so no database is touched.
const ROOT = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'job-bot-backup-'));
after(() => rmSync(root, { recursive: true, force: true }));

// Fake pg_dump programs in Node, so the in-process tests run on every OS.
const okDump = join(root, 'ok-dump.mjs');
writeFileSync(okDump, "process.stdout.write('-- dump of ' + process.argv.slice(2).join(' ') + '\\n');");
const failDump = join(root, 'fail-dump.mjs');
writeFileSync(failDump, "process.stderr.write('connection refused\\n'); process.exit(1);");

// A fixed date, so a run that crosses midnight still finds its file.
const DATE = '2026-03-15';
const opts = (dir: string, o: Partial<BackupOptions> = {}): BackupOptions => ({
  db: 'testdb',
  dir,
  keep: 14,
  date: DATE,
  pgDump: [process.execPath, okDump],
  host: '127.0.0.1',
  port: '5432',
  user: 'postgres',
  ...o,
});

describe('backup', () => {
  it('writes a gzipped dump named <db>-YYYY-MM-DD.sql.gz', async () => {
    const dir = join(root, 'out1');
    const lines = await backup(opts(dir));
    const file = join(dir, `testdb-${DATE}.sql.gz`);
    assert.match(lines[0], /^backup: .*testdb-2026-03-15\.sql\.gz \(\d+B\)$/);
    const sql = gunzipSync(readFileSync(file)).toString();
    assert.equal(sql, '-- dump of -h 127.0.0.1 -p 5432 -U postgres --no-owner testdb\n');
  });

  it('keeps only the newest 14 backups, and leaves other databases alone', async () => {
    const dir = join(root, 'out2');
    mkdirSync(dir);
    for (let day = 1; day <= 20; day++) writeFileSync(join(dir, `testdb-2026-01-${String(day).padStart(2, '0')}.sql.gz`), '');
    writeFileSync(join(dir, 'other-2020-01-01.sql.gz'), '');
    writeFileSync(join(dir, 'testdbx-2020-01-01.sql.gz'), '');
    const lines = await backup(opts(dir));
    const left = readdirSync(dir)
      .filter((f) => f.startsWith('testdb-'))
      .sort();
    assert.equal(left.length, 14);
    assert.equal(left.at(-1), `testdb-${DATE}.sql.gz`);
    assert.equal(left[0], 'testdb-2026-01-08.sql.gz');
    assert.equal(lines.filter((l) => l.startsWith('backup: removed')).length, 7);
    assert.ok(existsSync(join(dir, 'other-2020-01-01.sql.gz')));
    assert.ok(existsSync(join(dir, 'testdbx-2020-01-01.sql.gz')));
  });

  it('throws with the pg_dump error and leaves no file when pg_dump fails', async () => {
    const dir = join(root, 'out3');
    await assert.rejects(backup(opts(dir, { pgDump: [process.execPath, failDump] })), /pg_dump exited 1\nconnection refused/);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('a failed dump does not replace the good backup of the same day', async () => {
    const dir = join(root, 'out6');
    await backup(opts(dir));
    await assert.rejects(backup(opts(dir, { pgDump: [process.execPath, failDump] })));
    assert.match(gunzipSync(readFileSync(join(dir, `testdb-${DATE}.sql.gz`))).toString(), /dump of/);
    assert.deepEqual(readdirSync(dir), [`testdb-${DATE}.sql.gz`]);
  });

  it('gives pg_dump the password as PGPASSWORD, never as an argument or in the log', async () => {
    const dir = join(root, 'out8');
    const envDump = join(root, 'env-dump.mjs');
    writeFileSync(envDump, "process.stdout.write('pw=' + process.env.PGPASSWORD + ' args=' + process.argv.slice(2).join(' '));");
    const lines = await backup(opts(dir, { pgDump: [process.execPath, envDump], password: 's3cret' }));
    const sql = gunzipSync(readFileSync(join(dir, `testdb-${DATE}.sql.gz`))).toString();
    assert.match(sql, /^pw=s3cret args=-h 127\.0\.0\.1 -p 5432 -U postgres --no-owner testdb$/);
    assert.ok(lines.every((l) => !l.includes('s3cret')));
  });

  it('throws when pg_dump cannot be started', async () => {
    await assert.rejects(backup(opts(join(root, 'out7'), { pgDump: [join(root, 'no-such-pg_dump')] })), /backup failed: .*ENOENT/);
  });
});

describe('backupOptions', () => {
  it('reads the JOB_BOT_BACKUP_* and PG* settings, with defaults', () => {
    assert.deepEqual(backupOptions({ JOB_BOT_BACKUP_DATE: DATE }, '/bin/pg_dump'), {
      db: 'job_bot',
      dir: resolve(ROOT, 'data', 'backups'),
      keep: 14,
      date: DATE,
      pgDump: ['/bin/pg_dump'],
      host: '127.0.0.1',
      port: '5432',
      user: 'postgres',
    });
    const o = backupOptions(
      { JOB_BOT_BACKUP_DB: 'x', JOB_BOT_BACKUP_DIR: root, JOB_BOT_BACKUP_KEEP: '3', PGHOST: 'h', PGPORT: '1', PGUSER: 'u' },
      'pg',
    );
    assert.deepEqual([o.db, o.dir, o.keep, o.host, o.port, o.user], ['x', root, 3, 'h', '1', 'u']);
  });

  it('takes the database, host, port, user and password from DATABASE_URL; PG* and JOB_BOT_BACKUP_DB win', () => {
    const url = 'postgres://bot:p%40ss@[::1]:5433/my_db';
    const o = backupOptions({ DATABASE_URL: url }, 'pg');
    assert.deepEqual([o.db, o.host, o.port, o.user, o.password], ['my_db', '::1', '5433', 'bot', 'p@ss']);
    const p = backupOptions({ DATABASE_URL: url, JOB_BOT_BACKUP_DB: 'x', PGHOST: 'h', PGPORT: '1', PGUSER: 'u', PGPASSWORD: 'w' }, 'pg');
    assert.deepEqual([p.db, p.host, p.port, p.user, p.password], ['x', 'h', '1', 'u', 'w']);
    const q = backupOptions({ DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/job_bot' }, 'pg');
    assert.equal('password' in q, false);
    assert.equal(backupOptions({ DATABASE_URL: 'not a url' }, 'pg').db, 'job_bot');
  });

  it("names the file after today's local date when no date is given", () => {
    const before = localDate();
    const { date } = backupOptions({}, 'pg');
    assert.ok([before, localDate()].includes(date), date);
  });

  it('refuses a JOB_BOT_BACKUP_DATE that is not YYYY-MM-DD, a bad keep, and a missing pg_dump', () => {
    assert.throws(() => backupOptions({ JOB_BOT_BACKUP_DATE: '../../etc' }, 'pg'), /must be YYYY-MM-DD, not \.\.\/\.\.\/etc/);
    assert.throws(() => backupOptions({ JOB_BOT_BACKUP_KEEP: '0' }, 'pg'), /JOB_BOT_BACKUP_KEEP/);
    assert.throws(() => backupOptions({}, null), /pg_dump not found/);
  });
});

describe('findPgDump', () => {
  const none = () => [];
  it('JOB_BOT_PG_DUMP wins, then PATH', () => {
    assert.equal(
      findPgDump({ JOB_BOT_PG_DUMP: '/x/pg_dump', PATH: '/usr/bin' }, 'linux', () => true, none),
      '/x/pg_dump',
    );
    assert.equal(
      findPgDump({ PATH: '/a:/usr/bin' }, 'linux', (p) => p === '/usr/bin/pg_dump', none),
      '/usr/bin/pg_dump',
    );
    assert.equal(
      findPgDump({ Path: 'C:\\a;C:\\pg\\bin' }, 'win32', (p) => p === 'C:\\pg\\bin\\pg_dump.exe', none),
      'C:\\pg\\bin\\pg_dump.exe',
    );
  });

  it('macOS: the newest DBngin version, then Postgres.app and Homebrew', () => {
    const list = (d: string) =>
      d === '/Users/Shared/DBngin/postgresql'
        ? ['9.6', '17.2', '16.4', '.DS_Store']
        : d === '/opt/homebrew/opt'
          ? ['postgresql@16', 'node']
          : [];
    assert.equal(
      findPgDump({ PATH: '' }, 'darwin', () => true, list),
      '/Users/Shared/DBngin/postgresql/17.2/bin/pg_dump',
    );
    assert.equal(
      findPgDump({ PATH: '' }, 'darwin', (p) => p.startsWith('/opt/'), list),
      '/opt/homebrew/opt/postgresql@16/bin/pg_dump',
    );
    assert.equal(
      findPgDump({ PATH: '' }, 'darwin', () => false, list),
      null,
    );
  });

  it('Windows: the newest version under Program Files\\PostgreSQL', () => {
    const list = (d: string) => (d === win32.join('D:\\Apps', 'PostgreSQL') ? ['16', '17'] : []);
    assert.equal(
      findPgDump({ ProgramFiles: 'D:\\Apps' }, 'win32', () => true, list),
      win32.join('D:\\Apps', 'PostgreSQL', '17', 'bin', 'pg_dump.exe'),
    );
  });

  it('Linux: Debian/Ubuntu and RHEL package folders', () => {
    const list = (d: string) => (d === '/usr/lib/postgresql' ? ['15', '17'] : d === '/usr' ? ['pgsql-16', 'lib'] : []);
    assert.equal(
      findPgDump({}, 'linux', () => true, list),
      '/usr/lib/postgresql/17/bin/pg_dump',
    );
    assert.equal(
      findPgDump({}, 'linux', (p) => p.includes('pgsql'), list),
      '/usr/pgsql-16/bin/pg_dump',
    );
  });
});

// The CLI command and the old script name, with a POSIX sh fake pg_dump on PATH (Windows cannot run one).
describe('bot backup and scripts/backup-db.sh', { skip: process.platform === 'win32' }, () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\necho "-- dump of $*"\n');
  chmodSync(join(bin, 'pg_dump'), 0o755);
  const env = (dir: string, more: Record<string, string> = {}) => ({
    PATH: `${bin}:${posix.dirname(process.execPath)}:/usr/bin:/bin`,
    JOB_BOT_BACKUP_DIR: dir,
    JOB_BOT_BACKUP_DB: 'testdb',
    JOB_BOT_BACKUP_DATE: DATE,
    ...more,
  });

  it('`bot backup` writes the dump and prints its path', () => {
    const dir = join(root, 'cli1');
    const r = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'backup'], { cwd: ROOT, encoding: 'utf8', env: env(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^backup: .*testdb-2026-03-15\.sql\.gz/);
    assert.match(gunzipSync(readFileSync(join(dir, `testdb-${DATE}.sql.gz`))).toString(), /-U postgres .*testdb$/m);
  });

  it('`bot backup` exits 1 on a bad date and creates nothing', () => {
    const dir = join(root, 'cli2');
    const r = spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'backup'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: env(dir, { JOB_BOT_BACKUP_DATE: '../../etc' }),
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be YYYY-MM-DD/);
    assert.equal(existsSync(dir), false);
  });

  it('scripts/backup-db.sh still works, from any folder', () => {
    const dir = join(root, 'sh1');
    const r = spawnSync('sh', [join(ROOT, 'scripts', 'backup-db.sh')], { cwd: root, encoding: 'utf8', env: env(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, `testdb-${DATE}.sql.gz`)));
  });
});
