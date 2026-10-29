import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// scripts/backup-db.sh runs against a fake pg_dump on PATH and a temp output dir, so no database is touched.
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'backup-db.sh');
const root = mkdtempSync(join(tmpdir(), 'job-bot-backup-'));
after(() => rmSync(root, { recursive: true, force: true }));

function fakePgDump(name: string, body: string) {
  const bin = join(root, name);
  mkdirSync(bin);
  writeFileSync(join(bin, 'pg_dump'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'pg_dump'), 0o755);
  return bin;
}

const run = (bin: string, dir: string) => spawnSync('bash', [SCRIPT], {
  encoding: 'utf8',
  env: { PATH: `${bin}:/usr/bin:/bin`, JOB_BOT_BACKUP_DIR: dir, JOB_BOT_BACKUP_DB: 'testdb' },
});

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

describe('scripts/backup-db.sh', () => {
  const ok = fakePgDump('ok', 'echo "-- dump of $*"');

  it('writes a gzipped dump named <db>-YYYY-MM-DD.sql.gz', () => {
    const dir = join(root, 'out1');
    const r = run(ok, dir);
    assert.equal(r.status, 0, r.stderr);
    const file = join(dir, `testdb-${today()}.sql.gz`);
    assert.ok(existsSync(file));
    const sql = gunzipSync(readFileSync(file)).toString();
    assert.match(sql, /-- dump of .*-U postgres .*testdb$/m);
  });

  it('keeps only the newest 14 backups', () => {
    const dir = join(root, 'out2');
    mkdirSync(dir);
    for (let day = 1; day <= 20; day++) writeFileSync(join(dir, `testdb-2026-01-${String(day).padStart(2, '0')}.sql.gz`), '');
    writeFileSync(join(dir, 'other-2020-01-01.sql.gz'), '');
    const r = run(ok, dir);
    assert.equal(r.status, 0, r.stderr);
    const left = readdirSync(dir).filter((f) => f.startsWith('testdb-')).sort();
    assert.equal(left.length, 14);
    assert.equal(left.at(-1), `testdb-${today()}.sql.gz`);
    assert.equal(left[0], 'testdb-2026-01-08.sql.gz');
    assert.ok(existsSync(join(dir, 'other-2020-01-01.sql.gz')), 'files of other databases are left alone');
  });

  it('exits non-zero and leaves no file when pg_dump fails', () => {
    const dir = join(root, 'out3');
    const r = run(fakePgDump('fail', 'echo "connection refused" >&2; exit 1'), dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /connection refused/);
    assert.deepEqual(readdirSync(dir), []);
  });
});
