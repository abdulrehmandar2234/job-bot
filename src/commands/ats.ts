import { existsSync, readFileSync } from 'node:fs';
import { path } from '../config.ts';
import { getJob } from '../db.ts';
import { atsReport, versionCv, type AtsReport } from '../ats.ts';
import { masterRaw, type VersionMeta } from '../cv/versions.ts';
import type { Cv } from '../cv/render.ts';
import type { Flags } from './shared.ts';

/**
 * The CV content to check: a built version (cv/versions/<id>/cv.json, e.g. laravel-v2 or custom-x) as it was sent,
 * else a cluster or 'default' rendered from the current master CV. Returns the cluster it stands for.
 */
function loadVersion(master: Cv, id: string): { cluster: string; cv: Cv } {
  const dir = path('cv', 'versions', id);
  if (existsSync(`${dir}/cv.json`) && existsSync(`${dir}/meta.json`)) {
    const meta = JSON.parse(readFileSync(`${dir}/meta.json`, 'utf8')) as VersionMeta;
    // A one-off custom version is its own thing, so even its own cluster can be suggested instead.
    return { cluster: meta.jobId ? id : meta.cluster, cv: JSON.parse(readFileSync(`${dir}/cv.json`, 'utf8')) as Cv };
  }
  return { cluster: id, cv: versionCv(master, id) };
}

const list = (items: string[]) => items.join(', ') || '-';

/** ats <id> [--cv cluster] [--json]: which job keywords the CV version shows, hides or lacks. */
export async function ats(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  const id = flags.cv && flags.cv !== 'true' ? flags.cv : j.cv_version ?? j.cluster ?? 'default';
  const source = flags.cv && flags.cv !== 'true' ? 'chosen with --cv' : j.cv_version ? 'prepared' : 'suggested';
  const master = JSON.parse(masterRaw()) as Cv;
  const { cluster, cv } = loadVersion(master, id);
  const r: AtsReport & { label: string; source: string } = {
    ...atsReport(`${j.title}\n${j.description}`, master, cv, cluster), label: id, source,
  };
  if (flags.json) return console.log(JSON.stringify(r));
  console.log(`CV keyword check — ${j.company} — ${j.title}`);
  console.log(`CV version     : ${id} (${source}), shows ${r.present.length} of ${r.total} job keywords`);
  console.log(`Shown          : ${list(r.present)}`);
  console.log(`Hidden but true: ${list(r.hiddenButTrue)}   (on your CV, but not near the top of this version)`);
  console.log(`Missing        : ${list(r.missing)}   (real gaps: not on your CV, do not add them)`);
  if (r.suggestion) {
    console.log(`Suggestion     : the "${r.suggestion.version}" version shows ${r.suggestion.shows} (+ ${list(r.suggestion.gains)})` +
      ` — prepare ${j.id} --cv ${r.suggestion.version}`);
  } else console.log('Suggestion     : no other version shows more of this job\'s keywords.');
}
