import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

// Housekeeping for files the bot leaves behind, run by `bot daily` (src/commands/daily.ts):
// - data/questions/*.txt and data/settings/*.json are temp files removed in a `finally`, which does not run when the
//   process is killed (SIGKILL, a timeout): anything older than a day is a leftover.
// - data/cv-backups gets a copy of the master CV per `cv:add-skills`: the newest CV_BACKUPS_KEEP stay.
// - cv/versions/custom-* (one-off CVs for a single job) are removed once their job is skipped, expired or rejected
//   and has not changed status for CUSTOM_VERSION_MAX_AGE_DAYS, unless a job with another status still uses it.
// Every function takes its folders (and the pool) as parameters and returns what it removed, so it is tested on
// temp folders and the test database.

export const TEMP_MAX_AGE_MS = 86_400_000;
export const CV_BACKUPS_KEEP = 20;
export const CUSTOM_VERSION_MAX_AGE_DAYS = 90;
/** The statuses whose one-off CVs may go: the job is over. */
export const FINISHED_STATUSES = ['skipped', 'expired', 'rejected'] as const;

const files = (dir: string) => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(dir, e.name));
};

/** Deletes the files directly in `dir` last modified more than `maxAgeMs` before `now`. Returns their paths. */
export function removeOldFiles(dir: string, maxAgeMs = TEMP_MAX_AGE_MS, now = Date.now()): string[] {
  const removed: string[] = [];
  for (const file of files(dir)) {
    if (now - statSync(file).mtimeMs <= maxAgeMs) continue;
    rmSync(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/** Keeps the `keep` most recently modified files directly in `dir` and deletes the rest. Returns their paths. */
export function keepNewest(dir: string, keep = CV_BACKUPS_KEEP): string[] {
  const old = files(dir)
    .map((file) => ({ file, at: statSync(file).mtimeMs }))
    .sort((a, b) => b.at - a.at || b.file.localeCompare(a.file))
    .slice(keep)
    .map((f) => f.file);
  for (const file of old) rmSync(file, { force: true });
  return old;
}

/**
 * The custom-* version folders under `versionsDir` that may go: the job in its meta.json is skipped, expired or
 * rejected, its status has not changed for `days` days (last job_events entry, closed_at or first_seen_at), and no
 * job with another status points at the version (jobs.cv_version). A folder without meta.json, or whose job is gone,
 * is left alone.
 */
export async function staleCustomVersions(db: pg.Pool, versionsDir: string, days = CUSTOM_VERSION_MAX_AGE_DAYS): Promise<string[]> {
  if (!existsSync(versionsDir)) return [];
  const metas: { id: string; jobId: string }[] = [];
  for (const d of readdirSync(versionsDir, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith('custom-')) continue;
    try {
      const meta = JSON.parse(readFileSync(join(versionsDir, d.name, 'meta.json'), 'utf8')) as { jobId?: unknown };
      if (typeof meta.jobId === 'string' && meta.jobId) metas.push({ id: d.name, jobId: meta.jobId });
    } catch {
      // no or unreadable meta.json: not ours to judge
    }
  }
  if (!metas.length) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT v.id FROM unnest($1::text[], $2::text[]) AS v(id, job_id)
      JOIN jobs j ON j.id = v.job_id
     WHERE j.status = ANY($3::text[])
       AND GREATEST((SELECT max(e.at) FROM job_events e WHERE e.job_id = j.id), j.closed_at, j.first_seen_at)
           < now() - make_interval(days => $4::int)
       AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.cv_version = v.id AND o.status <> ALL($3::text[]))`,
    [metas.map((m) => m.id), metas.map((m) => m.jobId), FINISHED_STATUSES, days],
  );
  return rows.map((r) => r.id).sort();
}

/** Deletes the folders staleCustomVersions picks. Returns their ids. */
export async function removeStaleCustomVersions(db: pg.Pool, versionsDir: string, days = CUSTOM_VERSION_MAX_AGE_DAYS) {
  const ids = await staleCustomVersions(db, versionsDir, days);
  for (const id of ids) rmSync(join(versionsDir, id), { recursive: true, force: true });
  return ids;
}

export type CleanupDirs = { data: string; cvBackups: string; versions: string };

/** The whole daily cleanup. Returns one log line per kind of file, naming what went. */
export async function cleanup(db: pg.Pool, dirs: CleanupDirs, now = Date.now()): Promise<string[]> {
  const lines: string[] = [];
  const report = (what: string, removed: string[]) => {
    if (removed.length) lines.push(`cleanup: removed ${removed.length} ${what}: ${removed.join(', ')}`);
  };
  report('old question files', removeOldFiles(join(dirs.data, 'questions'), TEMP_MAX_AGE_MS, now));
  report('old settings files', removeOldFiles(join(dirs.data, 'settings'), TEMP_MAX_AGE_MS, now));
  report(`CV backups (keeping the newest ${CV_BACKUPS_KEEP})`, keepNewest(dirs.cvBackups, CV_BACKUPS_KEEP));
  report('one-off CV versions of finished jobs', await removeStaleCustomVersions(db, dirs.versions));
  if (!lines.length) lines.push('cleanup: nothing to remove');
  return lines;
}
