import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config, path } from '../config.ts';
import { PROFILES, type Profile } from './profiles.ts';
import { renderPdf, type Cv } from './render.ts';

// Layout on disk (the PDF file name is identical in every folder, only the folder name differs):
//   cv/default/<cvFileName>                  untouched original PDF
//   cv/versions/<cluster>-v<N>/<cvFileName>  generated variant + cv.json + meta.json
//   cv/versions/custom-<slug>/...            one-off variant made for a single job

export type VersionMeta = { id: string; cluster: string; masterHash: string; createdAt: string; jobId?: string };

const VERSIONS = path('cv', 'versions');
export const masterRaw = () => readFileSync(path('cv', 'master.json'), 'utf8');
// Covers everything that shapes a version's content, so editing the CV, a profile or the template yields v(N+1)
// while older versions stay on disk for the jobs they were sent to.
export const masterHash = () => createHash('sha256')
  .update(masterRaw())
  .update(readFileSync(path('src', 'cv', 'profiles.ts')))
  .update(readFileSync(path('src', 'cv', 'render.ts')))
  .digest('hex').slice(0, 12);
export const cvFile = (versionId: string) =>
  versionId === 'default' ? path('cv', 'default', config.cvFileName) : path('cv', 'versions', versionId, config.cvFileName);

export function listVersions(): VersionMeta[] {
  if (!existsSync(VERSIONS)) return [];
  return readdirSync(VERSIONS)
    .filter((d) => existsSync(path('cv', 'versions', d, 'meta.json')))
    .map((d) => JSON.parse(readFileSync(path('cv', 'versions', d, 'meta.json'), 'utf8')) as VersionMeta);
}

const frontFirst = <T>(items: T[], key: (t: T) => string, first: string[]) => {
  const rank = (t: T) => { const i = first.indexOf(key(t)); return i === -1 ? first.length : i; };
  return [...items].map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t);
};

export function applyProfile(master: Cv, p: Profile): Cv {
  const projectRank = (tags: string[]) => (tags.some((t) => p.projectTags.includes(t)) ? 0 : 1);
  return {
    ...master,
    title: p.title,
    summary: p.summary,
    skills: frontFirst(master.skills, (g) => g.group, p.groupsFirst)
      .map((g) => ({ ...g, items: frontFirst(g.items, (s) => s, p.skillsFirst) })),
    // The first bullet introduces the role, so it stays first; the rest are ordered by relevance.
    experience: master.experience.map((e) => ({
      ...e,
      bullets: [e.bullets[0], ...e.bullets.slice(1).sort((a, b) => Number(p.bulletKeywords.test(b)) - Number(p.bulletKeywords.test(a)))],
    })),
    projects: [...master.projects].sort((a, b) => projectRank(a.tags) - projectRank(b.tags)),
  };
}

async function writeVersion(id: string, cluster: string, cv: Cv, jobId?: string): Promise<VersionMeta> {
  const dir = path('cv', 'versions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/cv.json`, JSON.stringify(cv, null, 2));
  await renderPdf(cv, `${dir}/${config.cvFileName}`);
  const meta: VersionMeta = { id, cluster, masterHash: masterHash(), createdAt: new Date().toISOString(), jobId };
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * Returns the CV version to send for a cluster. Reuses an existing version built from the
 * current master CV; only renders a new one when none exists or master.json has changed.
 */
export async function versionFor(cluster: string): Promise<{ id: string; created: boolean }> {
  if (cluster === 'default' || !PROFILES[cluster]) return { id: 'default', created: false };
  const hash = masterHash();
  const same = listVersions().filter((v) => v.cluster === cluster && !v.jobId);
  const current = same.find((v) => v.masterHash === hash);
  if (current) return { id: current.id, created: false };
  const n = Math.max(0, ...same.map((v) => Number(v.id.match(/-v(\d+)$/)?.[1] ?? 0))) + 1;
  const master = JSON.parse(masterRaw()) as Cv;
  const meta = await writeVersion(`${cluster}-v${n}`, cluster, applyProfile(master, PROFILES[cluster]));
  return { id: meta.id, created: true };
}

/**
 * One-off variant for a single job. `overrides` may only re-frame: title, summary,
 * and orderings. It is merged over the cluster profile (or the master CV).
 */
export async function customVersion(slug: string, cluster: string, jobId: string, overrides: Partial<Profile>) {
  const master = JSON.parse(masterRaw()) as Cv;
  const base = PROFILES[cluster] ?? {
    title: master.title, summary: master.summary, skillsFirst: [], groupsFirst: [], projectTags: [], bulletKeywords: /$^/,
  };
  const p: Profile = { ...base, ...overrides, bulletKeywords: overrides.bulletKeywords ? new RegExp(overrides.bulletKeywords, 'i') : base.bulletKeywords };
  return writeVersion(`custom-${slug}`, cluster, applyProfile(master, p), jobId);
}
