import { readFileSync } from 'node:fs';
import { getJob, pool } from '../db.ts';
import { cvFile, customVersion, listVersions, masterRaw, versionFor } from '../cv/versions.ts';
import { renderPdf, type Cv } from '../cv/render.ts';
import { PROFILES } from '../cv/profiles.ts';
import { slug, type Flags } from './shared.ts';

/** Re-renders the default CV from cv/master.json. The original PDF stays in cv/original/. */
export async function cvDefault() {
  await renderPdf(JSON.parse(masterRaw()) as Cv, cvFile('default'));
  console.log(`default CV rebuilt from master.json → ${cvFile('default')}`);
}

/** cv:build [cluster...]: pre-builds CV versions (all profiles by default). */
export async function cvBuild(args: string[]) {
  for (const cluster of args.length ? args : Object.keys(PROFILES)) {
    const v = await versionFor(cluster);
    console.log(`${v.created ? 'built ' : 'exists'} ${v.id}  → ${cvFile(v.id)}`);
  }
}

export async function versions() {
  const { rows } = await pool.query<{ cv_version: string; n: number }>(
    'SELECT cv_version, count(*)::int n FROM jobs WHERE cv_version IS NOT NULL GROUP BY 1');
  const used = (id: string) => rows.find((r) => r.cv_version === id)?.n ?? 0;
  console.log(`default            → ${cvFile('default')}  (used for ${used('default')} jobs)`);
  for (const v of listVersions()) console.log(`${v.id.padEnd(18)} → ${cvFile(v.id)}  (used for ${used(v.id)} jobs)`);
}

/** One-off CV for a single job: --overrides file.json with {title, summary, skillsFirst, groupsFirst, projectTags, bulletKeywords} */
export async function custom(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  const overrides = JSON.parse(readFileSync(flags.overrides, 'utf8'));
  const meta = await customVersion(slug(`${j.company}-${j.title}`).slice(0, 40), j.cluster ?? 'default', j.id, overrides);
  await pool.query('UPDATE jobs SET cv_version = $2 WHERE id = $1', [j.id, meta.id]);
  console.log(`Custom CV: ${cvFile(meta.id)}`);
}
