import { statSync } from 'node:fs';
import { runBot } from '@/lib/bot';
import { masterFile } from '@/lib/settings';

/** What `bot ats <id> --json` returns (src/ats.ts AtsReport plus the version checked). */
export type AtsReport = {
  label: string; // version checked, e.g. laravel-v2 or next-nest
  source: string; // prepared | suggested | chosen with --cv
  present: string[];
  hiddenButTrue: string[];
  missing: string[];
  total: number;
  suggestion: { version: string; shows: number; gains: string[] } | null;
};

// Enough for a browsing session of job-detail views; cleared wholesale when full, which is fine for a
// single-user dashboard that looks at one job at a time.
const MAX_ENTRIES = 50;
const cache = new Map<string, AtsReport>();

/** The master CV's mtime: editing cv/master.json invalidates every cached report. 0 when the file is missing. */
function masterMtime(): number {
  try {
    return statSync(masterFile()).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * `bot ats <id> --json`, cached, so a job-detail view does not spawn a full Node subprocess on every look.
 * The report is built from the job's text, its CV version and the master CV (src/commands/ats.ts; it never reads
 * applicant.json), so the key is (job, CV version, master-CV mtime): preparing a new version or editing
 * cv/master.json re-runs the check. A run that fails or prints something else than a report is never cached.
 */
export async function cachedAtsReport(jobId: string, cvVersion: string | null): Promise<AtsReport> {
  const key = JSON.stringify([jobId, cvVersion, masterMtime()]);
  const hit = cache.get(key);
  if (hit) return hit;
  const report = JSON.parse(await runBot(['ats', jobId, '--json'])) as AtsReport;
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, report);
  return report;
}

/** Tests only: start from an empty cache. */
export const clearAtsCache = () => cache.clear();
