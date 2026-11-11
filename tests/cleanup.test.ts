import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.ts';
import { cleanup, keepNewest, removeOldFiles, staleCustomVersions } from '../src/cleanup.ts';
import { migrate, pool } from '../src/db.ts';

// `bot daily`'s cleanup (src/cleanup.ts) on temp folders and the test database. Jobs use the `cleanup:` id prefix.
const root = mkdtempSync(join(tmpdir(), 'talaash-cleanup-'));
after(() => rmSync(root, { recursive: true, force: true }));

const DAY = 86_400_000;
const NOW = Date.now();

/** A file in `dir` last modified `ageMs` ago. */
function file(dir: string, name: string, ageMs: number) {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, name);
  writeFileSync(f, name);
  const at = new Date(NOW - ageMs);
  utimesSync(f, at, at);
  return f;
}

describe('removeOldFiles', () => {
  it('deletes files older than the limit and keeps fresh ones and sub-folders', () => {
    const dir = join(root, 'questions');
    const old = file(dir, 'old.txt', 2 * DAY);
    const fresh = file(dir, 'fresh.txt', DAY / 2);
    mkdirSync(join(dir, 'sub'));
    assert.deepEqual(removeOldFiles(dir, DAY, NOW), [old]);
    assert.equal(existsSync(fresh), true);
    assert.equal(existsSync(join(dir, 'sub')), true);
  });

  it('a missing folder removes nothing', () => {
    assert.deepEqual(removeOldFiles(join(root, 'nope')), []);
  });
});

describe('keepNewest', () => {
  it('keeps the newest 20 CV backups and deletes the older ones', () => {
    const dir = join(root, 'cv-backups');
    for (let i = 0; i < 23; i++) file(dir, `master-${String(i).padStart(2, '0')}.json`, i * 1000);
    const removed = keepNewest(dir, 20);
    assert.deepEqual(removed.map((f) => f.slice(dir.length + 1)).sort(), ['master-20.json', 'master-21.json', 'master-22.json']);
    assert.equal(readdirSync(dir).length, 20);
    assert.deepEqual(keepNewest(dir, 20), []);
  });
});

describe('custom CV versions', () => {
  const versions = join(root, 'versions');
  const version = (id: string, jobId?: string) => {
    mkdirSync(join(versions, id), { recursive: true });
    writeFileSync(join(versions, id, 'meta.json'), JSON.stringify({ id, cluster: 'default', masterHash: 'x', createdAt: '', jobId }));
  };
  /** A job with `status`, whose last status change was `days` ago. */
  async function job(id: string, status: string, days: number, cvVersion: string | null = null) {
    await pool.query(
      `INSERT INTO jobs (id, source, company, title, url, status, cv_version, first_seen_at)
       VALUES ($1, 'manual', 'Acme', 'Engineer', 'https://example.com/' || $1, $2, $3, now() - make_interval(days => $4::int))`,
      [id, status, cvVersion, days + 10],
    );
    await pool.query(
      `INSERT INTO job_events (job_id, from_status, to_status, at) VALUES ($1, 'new', $2, now() - make_interval(days => $3::int))`,
      [id, status, days],
    );
  }

  before(migrate);
  beforeEach(async () => {
    rmSync(versions, { recursive: true, force: true });
    await pool.query(`DELETE FROM jobs WHERE id LIKE 'cleanup:%'`);
  });
  after(async () => {
    await pool.query(`DELETE FROM jobs WHERE id LIKE 'cleanup:%'`);
    await pool.end();
  });

  it('picks the versions of skipped, expired or rejected jobs untouched for 90 days, and nothing else', async () => {
    version('custom-old-skipped-v1', 'cleanup:skipped');
    version('custom-old-expired-v1', 'cleanup:expired');
    version('custom-old-rejected-v1', 'cleanup:rejected');
    version('custom-recent-v1', 'cleanup:recent');
    version('custom-applied-v1', 'cleanup:applied');
    version('custom-gone-v1', 'cleanup:no-such-job');
    version('custom-nometa-v1');
    mkdirSync(join(versions, 'custom-empty-v1'));
    version('default-modern-v1', 'cleanup:skipped'); // not a one-off CV
    await job('cleanup:skipped', 'skipped', 120);
    await job('cleanup:expired', 'expired', 91);
    await job('cleanup:rejected', 'rejected', 200);
    await job('cleanup:recent', 'skipped', 30);
    await job('cleanup:applied', 'applied', 200);
    assert.deepEqual(await staleCustomVersions(pool, versions), [
      'custom-old-expired-v1',
      'custom-old-rejected-v1',
      'custom-old-skipped-v1',
    ]);
  });

  it('keeps a version another job still uses, and removes it once only finished jobs point at it', async () => {
    version('custom-shared-v1', 'cleanup:old');
    await job('cleanup:old', 'skipped', 120, 'custom-shared-v1');
    await job('cleanup:live', 'interview', 120, 'custom-shared-v1');
    assert.deepEqual(await staleCustomVersions(pool, versions), []);

    await pool.query(`UPDATE jobs SET status = 'rejected' WHERE id = 'cleanup:live'`);
    const lines = await cleanup(pool, { data: join(root, 'no-data'), cvBackups: join(root, 'no-backups'), versions }, NOW);
    assert.deepEqual(lines, ['cleanup: removed 1 one-off CV versions of finished jobs: custom-shared-v1']);
    assert.equal(existsSync(join(versions, 'custom-shared-v1')), false);
  });

  it('cleanup removes old temp files in data/questions and data/settings and says when there was nothing to do', async () => {
    const data = join(root, 'data');
    const q = file(join(data, 'questions'), 'q.txt', 2 * DAY);
    const s = file(join(data, 'settings'), 's.json', 3 * DAY);
    const keep = file(join(data, 'settings'), 'now.json', 1000);
    const dirs = { data, cvBackups: join(data, 'cv-backups'), versions };
    const lines = await cleanup(pool, dirs, NOW);
    assert.deepEqual(lines, [`cleanup: removed 1 old question files: ${q}`, `cleanup: removed 1 old settings files: ${s}`]);
    assert.equal(existsSync(keep), true);
    assert.deepEqual(await cleanup(pool, dirs, NOW), ['cleanup: nothing to remove']);
  });
});
