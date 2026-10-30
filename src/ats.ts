import { SKILLS } from './match.ts';
import { PROFILES } from './cv/profiles.ts';
import { profileFor } from './cv/profile-fit.ts';
import { applyProfile } from './cv/versions.ts';
import type { Cv } from './cv/render.ts';

// ATS keyword check: which of a job's keywords (the skill vocabulary match.ts scores with) a CV version shows near
// the top, which are true (on master.json) but not shown there, and which are real gaps. Gaps are never suggested.

// What a recruiter or ATS ranking sees first: everything above this "fold" counts as shown.
const FOLD = { skillGroups: 3, roles: 2, bullets: 3, projects: 2 };

export type AtsResult = {
  version: string;
  present: string[]; // job keywords this version shows
  hiddenButTrue: string[]; // on master.json, but not shown in this version: the actionable ones
  missing: string[]; // not on master.json at all: real gaps, never to be added
};
export type AtsSuggestion = { version: string; shows: number; gains: string[] };
export type AtsReport = AtsResult & { total: number; suggestion: AtsSuggestion | null };

/**
 * The content of a version built from the master CV: 'default' is the master itself, a cluster re-frames it (with
 * the profile's text only when it fits this master, as versionFor builds it).
 */
export function versionCv(master: Cv, version: string): Cv {
  const p = profileFor(version, master);
  return p ? applyProfile(master, p) : master;
}

/** The part of a CV above the fold, as plain text. */
export function foldText(cv: Cv): string {
  return [
    cv.title,
    cv.summary,
    ...cv.skills.slice(0, FOLD.skillGroups).flatMap((g) => [g.group, ...g.items]),
    ...cv.experience.slice(0, FOLD.roles).flatMap((e) => [e.role, ...e.bullets.slice(0, FOLD.bullets)]),
    ...cv.projects.slice(0, FOLD.projects).map((p) => `${p.name} ${p.text}`),
  ].join('\n');
}

const fullText = (cv: Cv) =>
  [
    cv.title,
    cv.summary,
    ...cv.skills.flatMap((g) => [g.group, ...g.items]),
    ...cv.experience.flatMap((e) => [e.role, ...e.bullets]),
    ...cv.projects.map((p) => `${p.name} ${p.text}`),
  ].join('\n');

/** Compares a job's keywords with what one CV version shows. `cv` is that version's content. */
export function atsCheck(jobText: string, master: Cv, cv: Cv, version: string): AtsResult {
  const shown = foldText(cv);
  const all = fullText(master);
  const res: AtsResult = { version, present: [], hiddenButTrue: [], missing: [] };
  for (const s of SKILLS) {
    if (!s.re.test(jobText)) continue;
    // `have` marks skills that are on the CV under another name (SQL: MySQL / PostgreSQL).
    if (!s.have && !s.re.test(all)) res.missing.push(s.name);
    else if (s.re.test(shown)) res.present.push(s.name);
    else res.hiddenButTrue.push(s.name);
  }
  return res;
}

/** The check for one version, plus the cluster version that shows the most job keywords when it beats this one. */
export function atsReport(jobText: string, master: Cv, cv: Cv, version: string): AtsReport {
  const res = atsCheck(jobText, master, cv, version);
  const candidates = ['default', ...Object.keys(PROFILES)]
    .map((v) => atsCheck(jobText, master, versionCv(master, v), v))
    .sort((a, b) => b.present.length - a.present.length);
  const best = candidates[0];
  const gains = best.present.filter((k) => !res.present.includes(k));
  return {
    ...res,
    total: res.present.length + res.hiddenButTrue.length + res.missing.length,
    suggestion:
      best.version !== version && best.present.length > res.present.length
        ? { version: best.version, shows: best.present.length, gains }
        : null,
  };
}
