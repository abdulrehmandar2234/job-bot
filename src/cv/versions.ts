import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config, path } from '../config.ts';
import { masterFile } from '../settings.ts';
import { PROFILES, type Profile } from './profiles.ts';
import { renderPdf, type Cv } from './render.ts';
import { DEFAULT_TEMPLATE, isTemplate, type TemplateId } from './templates/index.ts';

// Layout on disk (the PDF file name is identical in every folder, only the folder name differs):
//   cv/default/<cvFileName>                    untouched original PDF (classic template)
//   cv/versions/<cluster>-v<N>/<cvFileName>    generated variant + cv.json + meta.json (classic template)
//   cv/versions/<cluster>-<template>-v<N>/...  the same in another template (modern, compact); cluster may be "default"
//   cv/versions/custom-<slug>-v<N>/...         one-off variant made for a single job (a new N every time)
// meta.json records the template; versions made before templates existed have none and are classic.

export type VersionMeta = {
  id: string;
  cluster: string;
  masterHash: string;
  createdAt: string;
  jobId?: string;
  template?: TemplateId;
  /** A CV revised with feedback (`cv:feedback`): the AI's note and what keepToMaster left out. */
  feedbackNote?: string[];
};

const VERSIONS = path('cv', 'versions');
// JOB_BOT_MASTER points at another CV (tests use cv/master.example.json).
export const masterRaw = () => readFileSync(masterFile(), 'utf8');
// Covers everything that shapes a version's content and look, so editing the CV, a profile or the template yields
// v(N+1) while older versions stay on disk for the jobs they were sent to.
export const masterHash = (template: TemplateId = DEFAULT_TEMPLATE) =>
  createHash('sha256')
    .update(masterRaw())
    .update(readFileSync(path('src', 'cv', 'profiles.ts')))
    .update(readFileSync(path('src', 'cv', 'render.ts')))
    .update(readFileSync(path('src', 'cv', 'templates', 'html.ts')))
    .update(readFileSync(path('src', 'cv', 'templates', `${template}.ts`)))
    .digest('hex')
    .slice(0, 12);
/** A version's template: the one in its meta.json, else classic (versions made before templates existed). */
export const versionTemplate = (meta: Pick<VersionMeta, 'template'> | null | undefined): TemplateId =>
  isTemplate(meta?.template) ? meta.template : DEFAULT_TEMPLATE;
/** The CV design for jobs without one of their own: config.json cvTemplate, else classic. */
export const defaultTemplate = (): TemplateId => config.cvTemplate ?? DEFAULT_TEMPLATE;
/** The CV design for a job: its own (jobs.cv_template, "Apply template"), else the default. */
export const jobTemplate = (j: { cv_template?: string | null }): TemplateId =>
  isTemplate(j.cv_template) ? j.cv_template : defaultTemplate();
export const cvFile = (versionId: string) =>
  versionId === 'default' ? path('cv', 'default', config.cvFileName) : path('cv', 'versions', versionId, config.cvFileName);

export function listVersions(): VersionMeta[] {
  if (!existsSync(VERSIONS)) return [];
  return readdirSync(VERSIONS)
    .filter((d) => existsSync(path('cv', 'versions', d, 'meta.json')))
    .map((d) => JSON.parse(readFileSync(path('cv', 'versions', d, 'meta.json'), 'utf8')) as VersionMeta);
}

const frontFirst = <T>(items: T[], key: (t: T) => string, first: string[]) => {
  const rank = (t: T) => {
    const i = first.indexOf(key(t));
    return i === -1 ? first.length : i;
  };
  return [...items]
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((x) => x.t);
};

export function applyProfile(master: Cv, p: Profile): Cv {
  const projectRank = (tags: string[]) => (tags.some((t) => p.projectTags.includes(t)) ? 0 : 1);
  return {
    ...master,
    title: p.title,
    summary: p.summary,
    skills: frontFirst(master.skills, (g) => g.group, p.groupsFirst).map((g) => ({
      ...g,
      items: frontFirst(g.items, (s) => s, p.skillsFirst),
    })),
    // The first bullet introduces the role, so it stays first; the rest are ordered by relevance.
    experience: master.experience.map((e) => ({
      ...e,
      bullets: [e.bullets[0], ...e.bullets.slice(1).sort((a, b) => Number(p.bulletKeywords.test(b)) - Number(p.bulletKeywords.test(a)))],
    })),
    projects: [...master.projects].sort((a, b) => projectRank(a.tags) - projectRank(b.tags)),
  };
}

async function writeVersion(
  id: string,
  cluster: string,
  cv: Cv,
  template: TemplateId,
  jobId?: string,
  extra: Pick<VersionMeta, 'feedbackNote'> = {},
): Promise<VersionMeta> {
  const dir = path('cv', 'versions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/cv.json`, JSON.stringify(cv, null, 2));
  await renderPdf(cv, `${dir}/${config.cvFileName}`, template);
  const meta: VersionMeta = {
    id,
    cluster,
    masterHash: masterHash(template),
    createdAt: new Date().toISOString(),
    jobId,
    template,
    ...extra,
  };
  writeFileSync(`${dir}/meta.json`, JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * The cluster's profile for the current master CV (src/cv/profile-fit.ts): its title and summary only when the master
 * shows everything they name, else the master's own. Imported on use: profile-fit needs src/match.ts, which reads
 * the master CV through this module while it loads, so a static import would be a cycle.
 */
async function fittedProfile(cluster: string): Promise<Profile | undefined> {
  const { profileFor } = await import('./profile-fit.ts');
  return profileFor(cluster, JSON.parse(masterRaw()) as Cv);
}

/**
 * Returns the CV version to send for a cluster in a template. Reuses an existing version built from the current
 * master CV; only renders a new one when none exists or master.json, the profiles or the template have changed.
 * The classic default CV is cv/default ("default"); in another template it is a `default-<template>-v<N>` version.
 */
export async function versionFor(cluster: string, template: TemplateId = DEFAULT_TEMPLATE): Promise<{ id: string; created: boolean }> {
  if (!PROFILES[cluster] && template === DEFAULT_TEMPLATE) return { id: 'default', created: false };
  const profile = await fittedProfile(cluster);
  const key = profile ? cluster : 'default';
  const hash = masterHash(template);
  const same = listVersions().filter((v) => v.cluster === key && !v.jobId && versionTemplate(v) === template);
  const current = same.find((v) => v.masterHash === hash);
  if (current) return { id: current.id, created: false };
  const n = Math.max(0, ...same.map((v) => Number(v.id.match(/-v(\d+)$/)?.[1] ?? 0))) + 1;
  const master = JSON.parse(masterRaw()) as Cv;
  const prefix = template === DEFAULT_TEMPLATE ? key : `${key}-${template}`;
  const meta = await writeVersion(`${prefix}-v${n}`, key, profile ? applyProfile(master, profile) : master, template);
  return { id: meta.id, created: true };
}

/**
 * Claims a new folder `custom-<slug>-v<N>` under cv/versions and returns its id. N is one above every version of
 * that slug on disk (an old unnumbered `custom-<slug>` counts as v1), and the folder is created exclusively, so a
 * folder is never reused: a CV that may already have been sent is never overwritten.
 */
export function claimCustomId(slug: string): string {
  mkdirSync(VERSIONS, { recursive: true });
  const base = `custom-${slug}`;
  const taken = readdirSync(VERSIONS).map((d) => {
    if (d === base) return 1;
    const n = d.startsWith(`${base}-v`) ? d.slice(base.length + 2) : '';
    return /^\d+$/.test(n) ? Number(n) : 0;
  });
  for (let n = Math.max(0, ...taken) + 1; ; n++) {
    const id = `${base}-v${n}`;
    try {
      mkdirSync(path('cv', 'versions', id));
      return id;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; // taken by a concurrent run: try the next N
    }
  }
}

/**
 * One-off variant for a single job, in a new folder every time (claimCustomId). `overrides` may only re-frame:
 * title, summary, and orderings. It is merged over the cluster profile (fittedProfile) or the master CV.
 */
export async function customVersion(
  slug: string,
  cluster: string,
  jobId: string,
  overrides: Partial<Profile>,
  template: TemplateId = DEFAULT_TEMPLATE,
) {
  const master = JSON.parse(masterRaw()) as Cv;
  const base = (await fittedProfile(cluster)) ?? {
    title: master.title,
    summary: master.summary,
    skillsFirst: [],
    groupsFirst: [],
    projectTags: [],
    bulletKeywords: /$^/,
  };
  const p: Profile = {
    ...base,
    ...overrides,
    bulletKeywords: overrides.bulletKeywords ? new RegExp(overrides.bulletKeywords, 'i') : base.bulletKeywords,
  };
  return writeVersion(claimCustomId(slug), cluster, applyProfile(master, p), template, jobId);
}

/**
 * One-off variant for a single job from CV data as it is (a CV revised with feedback, or a CV shown in another
 * template), in a new folder every time (claimCustomId). The caller makes sure `cv` only holds master CV content.
 */
export function customCv(slug: string, cluster: string, jobId: string, cv: Cv, template: TemplateId, feedbackNote?: string[]) {
  return writeVersion(claimCustomId(slug), cluster, cv, template, jobId, feedbackNote?.length ? { feedbackNote } : {});
}

/** A version's meta.json, or null for "default" and unknown ids. */
export function versionMeta(id: string): VersionMeta | null {
  if (id === 'default' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const file = path('cv', 'versions', id, 'meta.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as VersionMeta) : null;
}

/** The CV data a version was rendered from: its cv.json, or the master CV for "default" and unknown ids. */
export function versionCv(id: string | null): Cv {
  const file = id && versionMeta(id) ? path('cv', 'versions', id, 'cv.json') : null;
  return JSON.parse(file && existsSync(file) ? readFileSync(file, 'utf8') : masterRaw()) as Cv;
}
