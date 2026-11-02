import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { path } from '../config.ts';
import { masterFile } from '../settings.ts';
import { SKILLS } from '../match.ts';
import type { Cv } from './render.ts';

// "I have this skill" on the job page's CV keyword check: the job asks for a skill the master CV does not show, and the
// candidate confirms they have it. Only then is it added to cv/master.json, so every later CV may show it. A skill
// nobody confirmed is never added: the CV rule ("only what is in cv/master.json") stays the check that counts.
// Before the master changes, a copy is kept in data/cv-backups/ (JOB_BOT_CV_BACKUP_DIR overrides it, for tests).

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

/** The folder the master CV is copied to before confirmed skills change it. */
export const backupDir = () => process.env.JOB_BOT_CV_BACKUP_DIR || path('data', 'cv-backups');

/**
 * Adds the confirmed skills to the master CV file. Writes a backup of the file as it was first, and writes nothing
 * when every skill is already on it. Returns what was added and where the backup is (null when nothing changed).
 */
export function confirmSkills(names: string[], now = new Date()): { added: string[]; backup: string | null } {
  const raw = readFileSync(masterFile(), 'utf8');
  const { cv, added } = addSkills(JSON.parse(raw) as Cv, names);
  if (!added.length) return { added, backup: null };
  mkdirSync(backupDir(), { recursive: true });
  const backup = join(backupDir(), `master-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backup, raw);
  writeFileSync(masterFile(), `${JSON.stringify(cv, null, 2)}\n`);
  return { added, backup };
}
