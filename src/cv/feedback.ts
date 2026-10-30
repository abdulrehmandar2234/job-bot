import { SKILLS } from '../match.ts';
import type { Cv } from './render.ts';

// "Improve CV with feedback" (`bot cv:feedback`): the AI proposes a revised CV for one job, and this module keeps
// only what the master CV (cv/master.json) supports. The prompt asks for the same, but this is the check that counts.
// The AI may reorder, re-frame, shorten or select: rewrite the title and summary, reorder and select skill groups,
// skills, bullets and projects, and drop projects. It may never add an employer, bullet, skill, project, number or
// claim. Everything it proposes is matched against the master; what does not match is left out and named in the note.

/** The CV the AI proposes: the parts it may change. Projects by name only; their text always comes from the master. */
export type CvProposal = {
  title: string;
  summary: string;
  skills: { group: string; items: string[] }[];
  experience: { company: string; role: string; bullets: string[] }[];
  projects: string[];
};

/** Lower case, straight quotes, plain dashes, single spaces and no trailing punctuation, for matching. */
export const normalize = (s: string) =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.;,:]+$/, '');

const clip = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** All text of the master CV, one string, for the title and summary checks. */
export function masterText(cv: Cv): string {
  return [
    cv.name,
    cv.title,
    cv.summary,
    ...cv.skills.flatMap((g) => [g.group, ...g.items]),
    ...cv.experience.flatMap((e) => [e.role, e.company, e.location, e.dates, ...e.tags, ...e.bullets]),
    ...cv.projects.flatMap((p) => [p.name, p.text, ...p.tags]),
    ...cv.education.flatMap((e) => [e.school, e.degree, e.dates]),
  ].join('\n');
}

/**
 * What a rewritten title or summary claims that the master CV does not show: known skills (src/match.ts) that the
 * master never mentions, and numbers (years, percentages, counts) that are not in it.
 */
export function unsupportedClaims(text: string, master: Cv): string[] {
  const all = masterText(master);
  const skills = SKILLS.filter((s) => s.re.test(text) && !s.re.test(all) && !s.cv?.test(all)).map((s) => s.name);
  const known = new Set(all.match(/\d+(?:[.,]\d+)*/g) ?? []);
  const numbers = (text.match(/\d+(?:[.,]\d+)*/g) ?? []).filter((n) => !known.has(n));
  return [...new Set([...skills, ...numbers])];
}

/**
 * The revised CV: the AI's proposal reduced to master CV content, plus one line per thing left out. Name, contact,
 * education, and each job's role, dates and location always come from the master; a title or summary that claims
 * more than the master keeps the current CV's (`current`, the job's CV before the feedback).
 */
export function keepToMaster(proposal: Partial<CvProposal>, master: Cv, current: Cv): { cv: Cv; removed: string[] } {
  const removed: string[] = [];

  const text = (key: 'title' | 'summary') => {
    const value = String(proposal[key] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!value) return current[key];
    const extra = unsupportedClaims(value, master);
    if (!extra.length) return value;
    removed.push(`The new ${key}, because it names ${extra.join(', ')}, which your master CV does not show (kept the current ${key})`);
    return current[key];
  };
  const title = text('title');
  const summary = text('summary');

  // Skills: a group must be a master group; a skill may sit in any group but must be on the master CV.
  const groups = new Map(master.skills.map((g) => [normalize(g.group), g.group]));
  const skills = new Map(master.skills.flatMap((g) => g.items.map((i) => [normalize(i), i] as const)));
  const usedGroups = new Set<string>();
  const usedSkills = new Set<string>();
  const skillGroups: Cv['skills'] = [];
  for (const g of proposal.skills ?? []) {
    const group = groups.get(normalize(g?.group));
    if (!group) {
      removed.push(`Skill group "${clip(String(g?.group ?? ''))}" (not on your master CV)`);
      continue;
    }
    if (usedGroups.has(group)) continue;
    usedGroups.add(group);
    const items: string[] = [];
    for (const raw of g.items ?? []) {
      const item = skills.get(normalize(raw));
      if (!item) removed.push(`Skill "${clip(String(raw))}" (not on your master CV)`);
      else if (!usedSkills.has(item)) {
        usedSkills.add(item);
        items.push(item);
      }
    }
    if (items.length) skillGroups.push({ group, items });
  }

  // Experience: only master employers, with master bullets. Every employer stays: the work history keeps no gaps.
  const jobKey = (e: { company: string }) => normalize(e.company);
  // The job's bullets on the current CV (only master ones), for a job the AI left without any.
  const currentBullets = (m: Cv['experience'][number]) => {
    const e = current.experience.find((x) => normalize(x.company) === normalize(m.company) && normalize(x.role) === normalize(m.role));
    const kept = (e?.bullets ?? []).filter((b) => m.bullets.includes(b));
    return kept.length ? kept : m.bullets;
  };
  const byCompany = new Map<string, Cv['experience'][number][]>();
  for (const e of master.experience) byCompany.set(jobKey(e), [...(byCompany.get(jobKey(e)) ?? []), e]);
  const usedJobs = new Set<Cv['experience'][number]>();
  const experience: Cv['experience'] = [];
  for (const p of proposal.experience ?? []) {
    const candidates = (byCompany.get(jobKey(p)) ?? []).filter((e) => !usedJobs.has(e));
    // Two roles at one employer: the role names which one.
    const m = candidates.find((e) => normalize(e.role) === normalize(p.role)) ?? candidates[0];
    if (!m) {
      if (!(byCompany.get(jobKey(p)) ?? []).length) removed.push(`Employer "${clip(String(p?.company ?? ''))}" (not on your master CV)`);
      continue;
    }
    usedJobs.add(m);
    const own = new Map(m.bullets.map((b) => [normalize(b), b]));
    const bullets: string[] = [];
    for (const raw of p.bullets ?? []) {
      const b = own.get(normalize(raw));
      if (!b) removed.push(`Bullet "${clip(String(raw))}" under ${m.company} (not on your master CV for that job)`);
      else if (!bullets.includes(b)) bullets.push(b);
    }
    experience.push({ ...m, bullets: bullets.length ? bullets : currentBullets(m) });
  }
  for (const m of master.experience) {
    if (usedJobs.has(m)) continue;
    experience.push({ ...m, bullets: currentBullets(m) });
    removed.push(`Dropping ${m.company} from the work experience (employers always stay on the CV, so it was kept)`);
  }

  // Projects: by name, with the master's text and link; any may be dropped.
  const projectsByName = new Map(master.projects.map((p) => [normalize(p.name), p]));
  const projects: Cv['projects'] = [];
  for (const name of proposal.projects ?? []) {
    const p = projectsByName.get(normalize(name));
    if (!p) removed.push(`Project "${clip(String(name))}" (not on your master CV)`);
    else if (!projects.includes(p)) projects.push(p);
  }

  return {
    cv: {
      name: master.name,
      title,
      contact: master.contact,
      summary,
      skills: skillGroups.length ? skillGroups : current.skills,
      experience,
      projects,
      education: master.education,
    },
    removed,
  };
}
