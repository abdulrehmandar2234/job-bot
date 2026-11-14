import { dataPath } from '../settings.ts';
import { SKILLS } from '../match.ts';
import type { Cv } from './render.ts';

// "I have this skill" on the job page's CV keyword check: the job asks for a skill the master CV does not show, and the
// candidate confirms they have it. The skill is kept for that one job (`jobs.cv_skills`): the job's CVs, keyword check
// and AI texts use jobMaster(), the master CV plus those skills. cv/master.json, the matching of every job and every
// other job's CV stay as they are, so a skill confirmed for one job never leaks into the rest. A skill nobody
// confirmed is never added.

/** The skill names that can be confirmed: the job keyword vocabulary of src/match.ts. */
export const SKILL_NAMES: readonly string[] = SKILLS.map((s) => s.name);

/** Where each skill goes on a master CV, by the words of its groups' names. The first group that matches wins. */
const GROUP_FOR: { group: RegExp; skills: string[] }[] = [
  { group: /language|runtime/i, skills: ['PHP', 'JavaScript', 'TypeScript', 'Node.js', 'Python', 'Go', 'Java', 'Ruby', 'C#/.NET'] },
  {
    group: /framework|librar/i,
    skills: [
      'Laravel',
      'Livewire',
      'Filament',
      'Inertia.js',
      'Alpine.js',
      'NestJS',
      'Express.js',
      'React',
      'Next.js',
      'Redux',
      'Vue.js',
      'Angular',
      'Tailwind CSS',
    ],
  },
  { group: /database|\borm|\bdata\b/i, skills: ['MongoDB', 'PostgreSQL', 'MySQL', 'SQL', 'Prisma', 'TypeORM', 'Redis'] },
  { group: /\bapi|\bweb\b|architect/i, skills: ['GraphQL', 'REST APIs', 'OAuth/JWT', 'Microservices', 'Kafka'] },
  { group: /devops|cloud|infra|tool/i, skills: ['AWS', 'Docker', 'CI/CD', 'Kubernetes', 'Terraform', 'GCP', 'Azure'] },
  { group: /test|practice|quality/i, skills: ['Testing'] },
  { group: /\bai\b|llm|machine learning/i, skills: ['LLM / AI'] },
];

/** How a skill is written on the CV when its keyword name would not be found there again (Go: "golang"). */
const CV_WORDING: Record<string, string> = { Go: 'Go (Golang)', Testing: 'Unit & integration testing' };

/** The CV item for a confirmed skill: its keyword name, or the wording the keyword check finds (CV_WORDING). */
export const cvItem = (skill: string) => CV_WORDING[skill] ?? skill;

/** The group a confirmed skill is added to when none of the master's groups fits it. */
export const OTHER_GROUP = 'Other Skills';

/** The master CV group for `skill`: the first group whose name fits the skill's kind, else OTHER_GROUP. */
export function groupFor(skill: string, groups: string[]): string {
  for (const g of GROUP_FOR) {
    if (!g.skills.includes(skill)) continue;
    const found = groups.find((name) => g.group.test(name));
    if (found) return found;
  }
  return OTHER_GROUP;
}

/** Whether the master CV already shows a skill (under its own name or other wording, as the keyword check sees it). */
function onCv(name: string, text: string): boolean {
  const s = SKILLS.find((x) => x.name === name);
  return !!s && (s.re.test(text) || !!s.cv?.test(text));
}

/**
 * The master CV with the confirmed skills added, each at the end of its group (groupFor). Skills it already shows are
 * skipped. Everything else in the CV, including keys this type does not know, stays as it is.
 */
export function addSkills<T extends Pick<Cv, 'skills'>>(master: T, names: string[]): { cv: T; added: string[] } {
  const text = master.skills.flatMap((g) => [g.group, ...g.items]).join('\n');
  const skills = master.skills.map((g) => ({ ...g, items: [...g.items] }));
  const added: string[] = [];
  for (const name of names) {
    if (added.includes(name) || onCv(name, text)) continue;
    const group = groupFor(
      name,
      skills.map((g) => g.group),
    );
    let target = skills.find((g) => g.group === group);
    if (!target) {
      target = { group, items: [] };
      skills.push(target);
    }
    target.items.push(cvItem(name));
    added.push(name);
  }
  return { cv: { ...master, skills }, added };
}

/**
 * The --add-skills flag as a list ([] when absent). Every name must be one of SKILL_NAMES; otherwise it returns the
 * error to show.
 */
export function parseSkills(flag: string | undefined): string[] | { error: string } {
  if (flag === undefined) return [];
  const names = [
    ...new Set(
      flag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!names.length || flag === 'true') return { error: '--add-skills needs skill names, e.g. --add-skills "Docker,GraphQL"' };
  const unknown = names.filter((n) => !SKILL_NAMES.includes(n));
  if (unknown.length) return { error: `Unknown skill: ${unknown.join(', ')}. Known skills: ${SKILL_NAMES.join(', ')}` };
  return names;
}

/**
 * The CV facts for one job: the master CV plus the skills confirmed for that job only (`jobs.cv_skills`), each in its
 * group (addSkills). The master CV itself is never written.
 */
export function jobMaster<T extends Pick<Cv, 'skills'>>(master: T, jobSkills: readonly string[] | null | undefined): T {
  return jobSkills?.length ? addSkills(master, [...jobSkills]).cv : master;
}

/**
 * The folder for copies of the master CV made before it is replaced (cv:import --apply). JOB_BOT_CV_BACKUP_DIR
 * overrides it, then JOB_BOT_DATA_DIR; `bot daily` keeps the newest 20 (src/cleanup.ts).
 */
export const backupDir = () => process.env.JOB_BOT_CV_BACKUP_DIR || dataPath('cv-backups');
