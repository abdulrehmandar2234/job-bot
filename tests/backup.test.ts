import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  backup,
  backupOptions,
  findPgDump,
  findPsql,
  localDate,
  restore,
  restoreOptions,
  type BackupOptions,
  type RestoreOptions,
} from '../src/backup.ts';

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
    // JOB_BOT_DATA_DIR moves the default; JOB_BOT_BACKUP_DIR still wins over it.
    assert.equal(backupOptions({ JOB_BOT_BACKUP_DATE: DATE, JOB_BOT_DATA_DIR: root }, '/bin/pg_dump').dir, resolve(root, 'backups'));
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

// Restore (src/backup.ts restore(), `bot restore`) runs against tests/fixtures/fake-psql.mjs, which logs every call
// (arguments, stdin, PGPASSWORD) and answers restore's queries from FAKE_PSQL_* variables. No database is touched.
const fakePsql = join(ROOT, 'tests', 'fixtures', 'fake-psql.mjs');
const DUMP = '--\n-- PostgreSQL database dump\n--\n\nCREATE TABLE public.jobs (id text);\n\n--\n-- PostgreSQL database dump complete\n--\n';
/** A gzipped dump like `bot backup` writes, in its own folder. */
const dumpFile = (name: string, body: Buffer | string = gzipSync(DUMP)) => {
  const dir = mkdtempSync(join(root, 'dump-'));
  writeFileSync(join(dir, name), body);
  return join(dir, name);
};
type PsqlCall = { args: string[]; stdin: string; password: string | null };
const FAKE_KEYS = [
  'FAKE_PSQL_LOG',
  'FAKE_PSQL_TABLES',
  'FAKE_PSQL_JOBS',
  'FAKE_PSQL_MIGRATION',
  'FAKE_PSQL_FAIL',
  'FAKE_PSQL_CONNECT_FAIL',
];
/** Sets the fake's answers for one test (clearing the previous test's) and returns its call log. */
const fake = (env: Record<string, string> = {}) => {
  const log = join(mkdtempSync(join(root, 'psql-')), 'calls.jsonl');
  for (const k of FAKE_KEYS) delete process.env[k];
  Object.assign(process.env, { FAKE_PSQL_LOG: log }, env);
  return () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as PsqlCall)
      : [];
};
after(() => {
  for (const k of FAKE_KEYS) delete process.env[k];
});
const ropts = (file: string, o: Partial<RestoreOptions> = {}): RestoreOptions => ({
  db: 'testdb',
  host: '127.0.0.1',
  port: '5432',
  user: 'postgres',
  file,
  yes: false,
  psql: [process.execPath, fakePsql],
  dir: mkdtempSync(join(root, 'safety-')),
  date: DATE,
  pgDump: null,
  ...o,
});
const loads = (calls: PsqlCall[]) => calls.filter((c) => !c.args.includes('-c'));
const TABLES = 'public.jobs,public.schema_migrations,public.tasks';

describe('restore', () => {
  it('refuses a database that has tables without --yes: names it, the backup date and size, and pipes nothing', async () => {
    const calls = fake({ FAKE_PSQL_TABLES: TABLES });
    const file = dumpFile('job_bot-2026-03-01.sql.gz');
    const logs: string[] = [];
    await assert.rejects(
      restore(ropts(file, { db: 'job_bot' }), (l) => logs.push(l)),
      (e: Error) => {
        assert.match(
          e.message,
          /database job_bot on 127\.0\.0\.1:5432 has 3 table\(s\) \(public\.jobs, public\.schema_migrations, public\.tasks\)/,
        );
        assert.match(
          e.message,
          /job_bot-2026-03-01\.sql\.gz \(backup of 2026-03-01, \d+B\) replaces all of its data\. Nothing was changed\./,
        );
        assert.match(e.message, /--yes/);
        return true;
      },
    );
    assert.equal(calls().length, 1);
    assert.deepEqual(loads(calls()), []);
    assert.deepEqual(logs, []);
  });

  it('with --yes backs the target up first, then pipes the unzipped dump into psql with ON_ERROR_STOP in one transaction', async () => {
    const calls = fake({ FAKE_PSQL_TABLES: TABLES, FAKE_PSQL_JOBS: '42' });
    // A safety backup of the same day as the file being restored must not overwrite that file.
    const file = dumpFile(`testdb-${DATE}.sql.gz`);
    const o = ropts(file, { yes: true, pgDump: [process.execPath, okDump], dir: dirname(file) });
    const logs: string[] = [];
    await restore(o, (l) => logs.push(l));
    // 1. The backup, of the target database, under its own name; the restored file is untouched.
    const safety = readdirSync(o.dir).filter((f) => f.includes('before-restore'));
    assert.equal(safety.length, 1);
    assert.match(safety[0], /^testdb-before-restore-2026-03-15-\d{6}\.sql\.gz$/);
    assert.match(gunzipSync(readFileSync(join(o.dir, safety[0]))).toString(), /--no-owner testdb\n$/);
    assert.equal(gunzipSync(readFileSync(file)).toString(), DUMP);
    assert.match(logs[0], /^backup: .*testdb-before-restore-.*\.sql\.gz \(\d+B\)$/);
    assert.match(logs[1], /restore that file to undo this restore/);
    // 2. Then the load: after the table check, one psql call with ON_ERROR_STOP, one transaction, the reset + the dump.
    const all = calls();
    const load = loads(all);
    assert.equal(load.length, 1);
    assert.ok(all.indexOf(load[0]) > 0);
    assert.ok(load[0].args.includes('ON_ERROR_STOP=1') && load[0].args.includes('--single-transaction'));
    assert.match(
      load[0].stdin,
      /^SET client_min_messages = warning;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n--\n-- PostgreSQL database dump/,
    );
    assert.ok(load[0].stdin.endsWith(DUMP));
    assert.ok(logs.findIndex((l) => l.startsWith('restore: loading')) > 1);
    // 3. The summary.
    assert.match(
      logs.join('\n'),
      /restore: done\. testdb has 3 table\(s\) and 42 job\(s\); latest migration in the backup: 015_cover_letter_ai_error\./,
    );
  });

  it('loads into an empty database without --yes and without a backup, and prints a summary', async () => {
    const calls = fake({ FAKE_PSQL_TABLES: '', FAKE_PSQL_JOBS: '7' });
    const file = dumpFile('testdb-2026-03-01.sql.gz');
    const o = ropts(file);
    const logs: string[] = [];
    await restore(o, (l) => logs.push(l));
    const load = loads(calls());
    assert.equal(load.length, 1);
    assert.deepEqual(load[0].args.slice(0, 13), [
      '-X',
      '-w',
      '-q',
      '-h',
      '127.0.0.1',
      '-p',
      '5432',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
    ]);
    assert.ok(load[0].args.includes('--single-transaction'));
    assert.equal(
      load[0].stdin,
      `SET client_min_messages = warning;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n${DUMP}`,
    );
    assert.deepEqual(readdirSync(o.dir), [], 'no safety backup of an empty database');
    // The summary: the fake reports no tables after the load either, so no job count; and the migration reminder.
    assert.match(logs.join('\n'), /restore: done\. testdb has 0 table\(s\)\./);
    assert.match(logs.at(-1) ?? '', /migrations newer than the backup apply on the next bot command/);
  });

  it('reads a plain .sql file too', async () => {
    const calls = fake();
    await restore(ropts(dumpFile('testdb.sql', DUMP)), () => {});
    assert.ok(loads(calls())[0].stdin.endsWith(DUMP));
  });

  it('--into targets the named database on the same server', async () => {
    const calls = fake();
    const o = restoreOptions(
      dumpFile('job_bot-2026-03-01.sql.gz'),
      { into: 'job_bot_copy' },
      { DATABASE_URL: 'postgres://postgres@127.0.0.1:5433/job_bot' },
      'psql',
      null,
    );
    assert.deepEqual([o.db, o.port], ['job_bot_copy', '5433']);
    await restore({ ...o, psql: [process.execPath, fakePsql] }, () => {});
    for (const c of calls()) assert.equal(c.args[c.args.indexOf('-d') + 1], 'job_bot_copy');
  });

  it('gives psql the password as PGPASSWORD, never as an argument, in the log or in an error', async () => {
    const o = restoreOptions(dumpFile('x-2026-03-01.sql.gz'), {}, { DATABASE_URL: 'postgres://bot:s3cret@127.0.0.1:5432/x' }, 'psql', null);
    const run = { ...o, psql: [process.execPath, fakePsql] };
    // A refusal (the database has tables) ...
    const refused = fake({ FAKE_PSQL_TABLES: TABLES });
    const err = await restore(run, () => {}).catch((e: Error) => e);
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes('s3cret'));
    // ... and a full restore into an empty one.
    const loaded = fake();
    const logs: string[] = [];
    await restore(run, (l) => logs.push(l));
    assert.equal(loads(loaded()).length, 1);
    for (const c of [...refused(), ...loaded()]) {
      assert.equal(c.password, 's3cret');
      assert.ok(!c.args.join(' ').includes('s3cret'));
    }
    assert.ok(logs.every((l) => !l.includes('s3cret')));
  });

  it('a missing, damaged or cut-short file is a clear error, before psql runs', async () => {
    const calls = fake();
    await assert.rejects(
      restore(ropts(join(root, 'no-such.sql.gz')), () => {}),
      /restore: cannot read .*no-such\.sql\.gz \(ENOENT\)/,
    );
    const damaged = gzipSync(DUMP).subarray(0, 30);
    await assert.rejects(
      restore(ropts(dumpFile('d.sql.gz', damaged)), () => {}),
      /is a damaged gzip file.*Nothing was changed/,
    );
    await assert.rejects(
      restore(ropts(dumpFile('c.sql.gz', gzipSync(DUMP.slice(0, 60)))), () => {}),
      /is not a complete pg_dump file/,
    );
    assert.deepEqual(calls(), []);
  });

  it('a failed load says nothing was changed (one transaction), with psql error', async () => {
    fake({ FAKE_PSQL_FAIL: 'ERROR:  relation "jobs" already exists' });
    await assert.rejects(
      restore(ropts(dumpFile('t-2026-03-01.sql.gz')), () => {}),
      /restore failed: psql exited 3\nERROR: {2}relation "jobs" already exists\nNothing was changed: the restore runs in one transaction\./,
    );
  });

  it('a database that does not exist: says to create it first', async () => {
    fake({ FAKE_PSQL_CONNECT_FAIL: 'psql: error: connection to server failed: FATAL:  database "nope" does not exist' });
    await assert.rejects(
      restore(ropts(dumpFile('t-2026-03-01.sql.gz'), { db: 'nope' }), () => {}),
      /restore: cannot open database nope on 127\.0\.0\.1:5432: psql exited 2\n.*does not exist\nCreate it first \(createdb -h 127\.0\.0\.1 -p 5432 -U postgres nope\)/,
    );
  });

  it('with --yes but no pg_dump for the safety backup: refuses and pipes nothing', async () => {
    const calls = fake({ FAKE_PSQL_TABLES: TABLES });
    await assert.rejects(
      restore(ropts(dumpFile('t-2026-03-01.sql.gz'), { yes: true }), () => {}),
      /pg_dump not found.*Nothing was changed/,
    );
    assert.deepEqual(loads(calls()), []);
  });
});

describe('restoreOptions', () => {
  it('targets the database `bot backup` dumps (DATABASE_URL, JOB_BOT_BACKUP_DB), and reads --yes', () => {
    const o = restoreOptions(
      'f.sql.gz',
      {},
      { DATABASE_URL: 'postgres://u@h:1/my_db', JOB_BOT_BACKUP_DATE: DATE },
      '/bin/psql',
      '/bin/pg_dump',
    );
    assert.deepEqual(
      [o.db, o.host, o.port, o.user, o.file, o.yes, o.psql, o.pgDump, o.date],
      ['my_db', 'h', '1', 'u', resolve('f.sql.gz'), false, ['/bin/psql'], ['/bin/pg_dump'], DATE],
    );
    assert.equal(restoreOptions('f', { yes: 'true' }, {}, 'psql', null).yes, true);
    assert.equal(restoreOptions('f', {}, { JOB_BOT_BACKUP_DB: 'other' }, 'psql', null).db, 'other');
    assert.equal(restoreOptions('f', {}, { JOB_BOT_BACKUP_DIR: root }, 'psql', null).dir, root);
  });

  it('refuses no file, --into without a name or with a name that is not a plain database name, and a missing psql', () => {
    assert.throws(() => restoreOptions(undefined, {}, {}, 'psql', null), /name the backup file/);
    assert.throws(() => restoreOptions('f', { into: 'true' }, {}, 'psql', null), /--into needs a database name/);
    assert.throws(() => restoreOptions('f', { into: 'postgres://evil/x' }, {}, 'psql', null), /not a database name restore accepts/);
    assert.throws(() => restoreOptions('f', {}, {}, null, null), /psql not found/);
  });
});

describe('findPsql', () => {
  const none = () => [];
  it('JOB_BOT_PSQL wins, then PATH, then the same install folders as pg_dump', () => {
    assert.equal(
      findPsql({ JOB_BOT_PSQL: '/x/psql', PATH: '/usr/bin' }, 'linux', () => true, none),
      '/x/psql',
    );
    assert.equal(
      findPsql({ PATH: '/a:/usr/bin' }, 'linux', (p) => p === '/usr/bin/psql', none),
      '/usr/bin/psql',
    );
    const dbngin = (d: string) => (d === '/Users/Shared/DBngin/postgresql' ? ['16.4', '18.4_arm'] : []);
    assert.equal(
      findPsql({ PATH: '' }, 'darwin', () => true, dbngin),
      '/Users/Shared/DBngin/postgresql/18.4_arm/bin/psql',
    );
    const win = (d: string) => (d === win32.join('C:\\Program Files', 'PostgreSQL') ? ['17'] : []);
    assert.equal(
      findPsql({}, 'win32', () => true, win),
      win32.join('C:\\Program Files', 'PostgreSQL', '17', 'bin', 'psql.exe'),
    );
    assert.equal(
      findPsql({}, 'linux', () => false, none),
      null,
    );
  });
});

// The CLI command and the old script name, with a POSIX sh fake pg_dump on PATH (Windows cannot run one).
describe('bot backup and scripts/backup-db.sh', { skip: process.platform === 'win32' }, () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\necho "-- dump of $*"\n');
  chmodSync(join(bin, 'pg_dump'), 0o755);
  writeFileSync(join(bin, 'psql'), `#!/bin/sh\nexec "${process.execPath}" "${fakePsql}" "$@"\n`);
  chmodSync(join(bin, 'psql'), 0o755);
  const env = (dir: string, more: Record<string, string> = {}) => ({
    PATH: `${bin}:${posix.dirname(process.execPath)}:/usr/bin:/bin`,
    JOB_BOT_BACKUP_DIR: dir,
    JOB_BOT_BACKUP_DB: 'testdb',
    JOB_BOT_CONFIG: join(ROOT, 'config.default.json'), // read-only here: no config.json is created in the repository
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

  const restoreCli = (cliArgs: string[], dir: string, more: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--no-warnings', 'src/cli.ts', 'restore', ...cliArgs], {
      cwd: ROOT,
      encoding: 'utf8',
      env: env(dir, { DATABASE_URL: 'postgres://bot:s3cret@127.0.0.1:5432/testdb', ...more }),
    });
  const callsIn = (log: string) =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as PsqlCall)
      : [];

  it('`bot restore` refuses a database with tables without --yes: exit 1, nothing loaded, no password shown', () => {
    const dir = join(root, 'rcli1');
    const log = join(root, 'rcli1.jsonl');
    const r = restoreCli([dumpFile('testdb-2026-03-01.sql.gz')], dir, { FAKE_PSQL_LOG: log, FAKE_PSQL_TABLES: TABLES });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /database testdb on 127\.0\.0\.1:5432 has 3 table\(s\)[\s\S]*backup of 2026-03-01[\s\S]*--yes/);
    assert.deepEqual(loads(callsIn(log)), []);
    assert.ok(!`${r.stdout}${r.stderr}`.includes('s3cret'));
    assert.equal(existsSync(dir), false, 'no backup taken');
  });

  it('`bot restore --yes <file>` backs up, then loads (the flag may come before the file)', () => {
    const dir = join(root, 'rcli2');
    const log = join(root, 'rcli2.jsonl');
    const r = restoreCli(['--yes', dumpFile('testdb-2026-03-01.sql.gz')], dir, { FAKE_PSQL_LOG: log, FAKE_PSQL_TABLES: TABLES });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^backup: .*testdb-before-restore-2026-03-15-\d{6}\.sql\.gz/);
    assert.match(r.stdout, /restore: done\. testdb has 3 table\(s\) and 0 job\(s\)/);
    assert.equal(loads(callsIn(log)).length, 1);
    assert.ok(!r.stdout.includes('s3cret'));
  });

  it('`bot restore` without a file, or with a missing one, exits 1 with a clear message', () => {
    const dir = join(root, 'rcli3');
    const none = restoreCli([], dir);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /restore: name the backup file/);
    const missing = restoreCli([join(root, 'nope.sql.gz'), '--into', 'job_bot_copy'], dir);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /restore: cannot read .*nope\.sql\.gz \(ENOENT\)/);
  });

  it('scripts/backup-db.sh still works, from any folder', () => {
    const dir = join(root, 'sh1');
    const r = spawnSync('sh', [join(ROOT, 'scripts', 'backup-db.sh')], { cwd: root, encoding: 'utf8', env: env(dir) });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, `testdb-${DATE}.sql.gz`)));
  });
});
