import { config, type Config } from './config.ts';
import { masterRaw } from './cv/versions.ts';
import { ConfigError } from './errors.ts';
import { DEFAULT_STACKS, loadStacks, pick, type Stack } from './presets.ts';
import { loadProfile, needsVisa, remoteFrom, remoteFromCode } from './profile.ts';
import { effectiveRemoteRules } from './regions.ts';
import { masterFile } from './settings.ts';
import { instructionFlag } from './posting-guard.ts';
import { isIndSponsor } from './sponsors.ts';
import type { RawJob } from './sources/index.ts';
import { DEFAULT_SKIP_JOB_TYPES, type JOB_TYPES, type VisaEvidence } from './types.ts';

type Skill = { name: string; re: RegExp; have: boolean; weight?: number; cv?: RegExp };

const CV_HINT =
  'every skill is checked against the master CV, so scoring cannot run without it — restore the file (or point JOB_BOT_MASTER at a valid CV JSON file)';

/**
 * The skill items of cv/master.json, one per line: what `have` is checked against. A missing or corrupt master CV
 * fails loudly (a ConfigError, so fetch stops once instead of failing every posting): swallowing it would mark every
 * skill as not on the CV and silently filter every posting.
 */
function cvSkills(): string {
  let raw: string;
  try {
    raw = masterRaw();
  } catch (e) {
    throw new ConfigError(`Cannot read the master CV at ${masterFile()}: ${(e as Error).message}; ${CV_HINT}.`);
  }
  let cv: { skills?: { items?: string[] }[] };
  try {
    cv = JSON.parse(raw) as { skills?: { items?: string[] }[] };
  } catch (e) {
    throw new ConfigError(`Cannot parse the master CV at ${masterFile()} as JSON: ${(e as Error).message}; ${CV_HINT}.`);
  }
  return (cv.skills ?? []).flatMap((g) => g.items ?? []).join('\n');
}

// Config patterns are compiled once and reused: scoreJob runs for thousands of postings per fetch, and recompiling
// the same RegExp for each one is pure waste. Keyed on the pattern text (not on the config object), so tests that
// swap config values in place still get the right matcher. All patterns come from config.json, so the map stays small.
const RE_CACHE = new Map<string, RegExp>();
function re(src: string): RegExp {
  let m = RE_CACHE.get(src);
  if (!m) {
    m = new RegExp(src, 'i');
    RE_CACHE.set(src, m);
  }
  return m;
}

/**
 * Marks each skill as on the CV (`have`) when its pattern, or its `cv` pattern, matches a skill listed in
 * cv/master.json. So `have` always follows the CV and is never claimed by hand.
 */
export function withCv<T extends Omit<Skill, 'have'>>(skills: T[], cvText: string): (T & { have: boolean })[] {
  return skills.map((s) => ({ ...s, have: s.re.test(cvText) || !!s.cv?.test(cvText) }));
}

// The stacks whose skills and CV clusters drive scoring: config.json `stacks`, missing or empty = the stacks
// config.default.json is built from, so existing config files behave as before. Stack preset files are read once.
let allStacks: Stack[] | null = null;
type StackSettings = Pick<Config, 'stacks'>;
const stackIds = (cfg: StackSettings) => (cfg.stacks?.length ? cfg.stacks : DEFAULT_STACKS);
const stacksKey = (cfg: StackSettings) => stackIds(cfg).join(',');
function activeStacks(cfg: StackSettings): Stack[] {
  allStacks ??= loadStacks();
  return pick(allStacks, stackIds(cfg), 'stacks');
}

// Skills the keyword score looks for whatever the stack; the active stacks' skills (presets/stacks/*.json) come
// first, and a stack skill with the same name replaces an entry here. `cv` = other CV wording that also proves it
// (MySQL proves SQL).
const BASE_SKILLS: Omit<Skill, 'have'>[] = [
  { name: 'MongoDB', re: /\bmongo(db)?\b/i },
  { name: 'PostgreSQL', re: /\bpostgres(ql)?\b/i },
  { name: 'MySQL', re: /\bmysql\b|\bmariadb\b/i },
  { name: 'SQL', re: /\bsql\b/i, cv: /mysql|postgres|mariadb|sqlite|sql server|oracle/i },
  { name: 'Prisma', re: /\bprisma\b/i },
  { name: 'TypeORM', re: /\btypeorm\b/i },
  { name: 'GraphQL', re: /\bgraphql\b/i },
  { name: 'REST APIs', re: /\brest(ful)?\b|\bapis?\b/i },
  { name: 'OAuth/JWT', re: /\boauth\b|\bjwt\b/i },
  { name: 'AWS', re: /\baws\b|amazon web services/i },
  { name: 'Docker', re: /\bdocker\b|\bcontainers?\b/i },
  { name: 'CI/CD', re: /\bci\/?cd\b|continuous integration/i },
  { name: 'Testing', re: /\bjest\b|\bphpunit\b|\bpest\b|\bmocha\b|unit test|integration test|\btdd\b/i },
  {
    name: 'LLM / AI',
    re: /\bllms?\b|\bopenai\b|\bgpt\b|generative ai|\bgenai\b|\bai agents?\b|prompt engineering/i,
    weight: 2,
  },
  { name: 'Microservices', re: /\bmicroservices?\b/i },
  { name: 'Angular', re: /\bangular\b/i, weight: 2 },
  { name: 'Tailwind CSS', re: /\btailwind/i },
  { name: 'Kubernetes', re: /\bkubernetes\b|\bk8s\b/i },
  { name: 'Redis', re: /\bredis\b/i },
  { name: 'Kafka', re: /\bkafka\b/i },
  { name: 'Terraform', re: /\bterraform\b/i },
  { name: 'GCP', re: /\bgcp\b|google cloud/i },
  { name: 'Azure', re: /\bazure\b/i },
  { name: 'Python', re: /\bpython\b|\bdjango\b|\bfastapi\b/i, weight: 2 },
  { name: 'Go', re: /\bgolang\b/i, weight: 2 },
  { name: 'Java', re: /\bjava\b(?!script)|\bspring boot\b/i, weight: 2 },
  { name: 'Ruby', re: /\bruby\b|\brails\b/i, weight: 2 },
  { name: 'C#/.NET', re: /\bc#|\.net\b/i, weight: 2 },
  // Markers for the big web stacks, like Python / Go / Java above: a posting built on one of them should still count
  // against a CV that lacks it. When that stack's preset is active, its own granular skills replace these by name.
  { name: 'PHP', re: /\bphp\b|\blaravel\b/i, weight: 2 },
  {
    name: 'JavaScript',
    re: /\bjavascript\b|\btypescript\b|\bnode(\.?js)?\b|\breact(\.?js)?\b|\bnext\.?js\b|\bvue(\.?js)?\b|\bnestjs\b/i,
    weight: 2,
  },
];

/** The active stacks' skills (in config order), then the cross-stack ones; the first entry with a name wins. */
function buildSkillPatterns(stacks: Stack[]): Omit<Skill, 'have'>[] {
  const out: Omit<Skill, 'have'>[] = [];
  const seen = new Set<string>();
  const push = (s: Omit<Skill, 'have'>) => {
    if (seen.has(s.name)) return;
    seen.add(s.name);
    out.push(s);
  };
  for (const st of stacks)
    for (const s of st.skills)
      push({ name: s.name, re: new RegExp(s.pattern, 'i'), weight: s.weight, cv: s.cv ? new RegExp(s.cv, 'i') : undefined });
  for (const s of BASE_SKILLS) push(s);
  return out;
}

// Loaded on first use, not at import time: src/cli.ts imports each command lazily, so commands that never score
// (list, mark, settings:check, ...) still run while cv/master.json is missing — only scoring itself fails loudly.
// Built once per `stacks` value (the settings' own, so a cfg passed to scoreJob gets its stacks' skills; tests swap
// config.stacks in place), so skill patterns stay compiled once, never per posting.
const skillsByStacks = new Map<string, Skill[]>();
function loadSkills(cfg: StackSettings): Skill[] {
  const key = stacksKey(cfg);
  let skills = skillsByStacks.get(key);
  if (!skills) {
    skills = withCv(buildSkillPatterns(activeStacks(cfg)), cvSkills());
    skillsByStacks.set(key, skills);
  }
  return skills;
}

// A lazy array of the CLI config's skills: reading it the first time loads the master CV (and reports a missing or
// corrupt one). Callers that have settings of their own pass them to scoreJob instead.
export const SKILLS: Skill[] = new Proxy([] as Skill[], {
  get: (_t, p) => {
    const skills = loadSkills(config);
    return Reflect.get(skills, p, skills);
  },
  has: (_t, p) => Reflect.has(loadSkills(config), p),
  ownKeys: () => Reflect.ownKeys(loadSkills(config)),
  getOwnPropertyDescriptor: (_t, p) => Reflect.getOwnPropertyDescriptor(loadSkills(config), p),
});

// Which CV version (cluster) fits a job. 'default' = the original PDF, untouched. The active stacks' clusters come
// from their preset files; the two here are cross-stack: LLM experience is the strongest differentiator, so it wins
// over plain stack clusters when the posting also asks for the JS stack, and still competes by specificity otherwise.
type Cluster = { id: string; priority: number; all: RegExp[]; none: RegExp[] };
const LLM = /\bllms?\b|\bopenai\b|generative ai|\bgenai\b|\bai agents?\b/i;
const BASE_CLUSTERS: Cluster[] = [
  { id: 'ai-fullstack', priority: 1, all: [LLM, /\bnode|\breact\b|\bnext\.?js|\bnest/i], none: [] },
  { id: 'ai-fullstack', priority: 0, all: [LLM], none: [] },
];

// Like the skill list: built once per `stacks` value, and sorted so the first matching cluster is the winner
// (highest priority first, then the most `all` conditions, merge order on ties).
const clustersByStacks = new Map<string, Cluster[]>();
function loadClusters(cfg: StackSettings): Cluster[] {
  const key = stacksKey(cfg);
  let merged = clustersByStacks.get(key);
  if (!merged) {
    merged = [
      ...BASE_CLUSTERS,
      ...activeStacks(cfg).flatMap((st) =>
        st.clusters.map((c) => ({
          id: c.id,
          priority: c.priority ?? 0,
          all: c.all.map((p) => new RegExp(p, 'i')),
          none: (c.none ?? []).map((p) => new RegExp(p, 'i')),
        })),
      ),
    ];
    merged.sort((a, b) => b.priority - a.priority || b.all.length - a.all.length);
    clustersByStacks.set(key, merged);
  }
  return merged;
}

export type Scored = {
  country: string | null;
  score: number;
  cluster: string;
  matched: string[];
  missing: string[];
  visa: string | null;
  visaEvidence: VisaEvidence | null;
  flags: string[];
  filterReason: string | null;
};

// Local languages a posting may require. A language the candidate speaks (profile `languages`) is never a blocker.
const LOCAL_LANGUAGES = ['dutch', 'arabic', 'german', 'french'];
const BONUS_LANGUAGES = ['dutch', 'arabic'];
const NEVER = /(?!)/;

// One entry per spoken-language set (one, in practice): the patterns are the same for every posting.
const LANG_CACHE = new Map<string, { required: RegExp; bonus: RegExp }>();

/** The "language required" and "language is a plus" patterns for the languages the candidate does not speak. */
export function languageRules(spoken: string[]): { required: RegExp; bonus: RegExp } {
  const key = spoken
    .map((l) => l.toLowerCase())
    .sort()
    .join(',');
  const cached = LANG_CACHE.get(key);
  if (cached) return cached;
  const known = new Set(spoken.map((l) => l.toLowerCase()));
  const req = LOCAL_LANGUAGES.filter((l) => !known.has(l)).join('|');
  const bonus = BONUS_LANGUAGES.filter((l) => !known.has(l)).join('|');
  const rules = {
    required: req
      ? new RegExp(
          `(fluent|fluency|native|proficien\\w*|excellent|strong|business[- ]level|professional)[^.\\n]{0,40}\\b(${req})\\b(?![^.\\n]{0,40}(is a plus|is a bonus|nice to have|preferred|advantage|beneficial))|\\b(${req})\\b[^.\\n]{0,25}\\b(required|mandatory|is a must|must)\\b`,
          'i',
        )
      : NEVER,
    bonus: bonus ? new RegExp(`\\b(${bonus})\\b[^.\\n]{0,40}(plus|bonus|nice to have|preferred|advantage|beneficial)`, 'i') : NEVER,
  };
  LANG_CACHE.set(key, rules);
  return rules;
}
const NO_SPONSOR =
  /(no|not|unable to|cannot|can't|don't|do not)\s[^.\n]{0,30}(visa )?sponsor|must (already )?have (the )?(right|authori[sz]ation|permit) to work|eu (work )?(permit|passport|citizen)|without (the need for )?sponsorship|local candidates only|saudi nationals only|saudization|uae nationals only|emirati(s)? only|emiratisation/i;
// Jobs only some people may hold, whatever the visa: a security clearance (tied to citizenship), and citizenship or
// permanent residency itself. "No clearance required" and the like must not match.
const NOT_REQUIRED = String.raw`(?<!\b(no|not|without|never|don't|doesn't)\s+((need|needs|require|requires|have|hold)\s+)?(an?\s+)?((active|current|valid|security|government|prior)\s+)*)`;
const CLEARANCE = new RegExp(
  String.raw`${NOT_REQUIRED}\b(active|current|valid|existing)\s+(security|government|secret|top[- ]secret|ts\/sci|sc|dv|nv1|nv2|baseline)\s+clearance|\b(must|able to|eligible to|ability to)\s+(hold|obtain|have|maintain|be granted|be eligible for)\s+[^.\n]{0,30}clearance|${NOT_REQUIRED}\b(security|government|secret|top[- ]secret)\s+clearance\s+(is\s+)?(required|mandatory|needed)|\bts\/sci\b|\btop[- ]secret\b[^.\n]{0,20}\bclearance`,
  'i',
);
const CITIZENS_ONLY =
  /\bcitizens?(hip)?\s+(is\s+|are\s+)?(only|required|mandatory)\b|\bmust\s+be\s+(an?\s+)?[a-z.]{2,15}\s+(citizen|national)\b|\bonly\s+(open|available)\s+to\s+[^.\n]{0,30}\b(citizens|nationals)\b|\b(citizens|nationals)\s+(and|or|\/)\s+(permanent\s+)?residents\s+only\b|\bpermanent\s+residen(ts?|cy)\s+(only|required|is required|status required)\b|\bmust\s+(be|hold)\s+(an?\s+)?(permanent\s+resident|green\s+card)|\bgreen\s+card\s+(holders?\s+)?(only|required)\b/i;

const SPONSOR =
  /visa sponsorship|sponsor (your |a )?visa|relocation (support|package|assistance)|we (will )?(help|support) (you )?(with )?relocat|work permit support/i;

// Strong "you must live in X" phrases; plain mentions of the US or EU in a description prove nothing.
const REMOTE_DESC_DENY =
  /\b(us|u\.s\.|uk|eu)[- ]based (candidates|applicants|only)|must (be|reside|live)[^.\n]{0,30}\b(in|within) the (us|u\.s\.|united states|uk|united kingdom|eu|european union)\b|authori[sz]ed to work in the (us|united states|uk|united kingdom)|(only|exclusively) (hiring|accepting)[^.\n]{0,30}(us|united states|europe|latam|latin america)|us time ?zones? (only|required)/i;

type JobType = (typeof JOB_TYPES)[number];

// The criteria lines a source adds to the description: LinkedIn's "Employment type" and "Seniority level" boxes
// (src/sources/linkedin.ts), freehire's seniority (src/sources/boards.ts). Only these structured lines count, not
// free text: "no part-time" or "after the internship" in a description must not filter a job.
const EMPLOYMENT_LINE = /^employment type:\s*(.+)$/im;
const SENIORITY_LINE = /^seniority level:\s*(.+)$/im;
const JOB_TYPE_WORDS: [RegExp, JobType][] = [
  [/\bintern(ship)?\b/i, 'internship'],
  [/\bpart[- ]?time\b/i, 'part-time'],
  [/\btemporary\b|\btemp\b/i, 'temporary'],
  [/\bcontract(or)?\b|\bfreelance\b/i, 'contract'],
  [/\bvolunteer\b/i, 'volunteer'],
];

/** The job type a source stated for the posting, with the line that says it, or null. */
export function jobTypeOf(description: string): { type: JobType; line: string } | null {
  for (const re of [SENIORITY_LINE, EMPLOYMENT_LINE]) {
    const m = description.match(re);
    if (!m) continue;
    const hit = JOB_TYPE_WORDS.find(([w]) => w.test(m[1]));
    if (hit && (re === EMPLOYMENT_LINE || hit[1] === 'internship')) return { type: hit[1], line: m[0].trim() };
  }
  return null;
}

/** The settings scoring reads: passed in, or the CLI's config.json when scoreJob gets none. */
export type MatchSettings = Pick<
  Config,
  'countries' | 'remote' | 'linkedin' | 'roleInclude' | 'roleExclude' | 'maxAgeDays' | 'minScore' | 'companies' | 'stacks' | 'skipJobTypes'
>;

/**
 * The title rule scoring applies (matches roleInclude, not roleExclude) as a predicate, so the sources can skip a
 * posting before its (slower) detail request. Both patterns come from the shared cache, compiled once.
 */
export function titleOk(cfg: Pick<MatchSettings, 'roleInclude' | 'roleExclude'> = config): (title: string) => boolean {
  const include = re(cfg.roleInclude);
  const exclude = re(cfg.roleExclude);
  return (title) => include.test(title) && !exclude.test(title);
}

/** The remote-from country for messages: "Pakistan", or "your country" when the profile does not say. */
const fromName = (cfg: MatchSettings) => remoteFrom(cfg, loadProfile()) ?? 'your country';

/** Location words that mark a posting as remote ("Remote — Worldwide", "Anywhere", "Work from home"). */
const REMOTE_WORDS = /\bremote\b|anywhere|worldwide|work from home/i;

/**
 * The region of a remote location ("Remote — EMEA" → "EMEA", "" for plain "Remote" or Arbeitnow's "Remote job"),
 * or null for a non-remote one.
 */
function remoteRegion(location: string): string | null {
  return REMOTE_WORDS.test(location) ? location.replace(/\bremote\b|\bjobs?\b|[—–\-(),:|/]/gi, ' ').trim() : null;
}

/** The remote allow / deny / flag rules for the candidate's country, compiled (from the shared cache). */
function remoteRules(cfg: MatchSettings) {
  const profile = loadProfile();
  const rules = effectiveRemoteRules(cfg.remote, remoteFromCode(cfg, profile), remoteFrom(cfg, profile));
  return { allow: re(rules.allow), deny: re(rules.deny), flag: re(rules.flag) };
}

/** A remote region the candidate may work from: none stated, "not stated", or one the allow rule takes. */
const regionOpen = (region: string, allow: RegExp) => !region || /not stated/i.test(region) || allow.test(region);

/**
 * Whether a posting's location is a remote job open to the candidate's country, by the location text alone (the
 * description's "US-based only" and the like are checked by scoreJob): 'not-remote' when remote jobs are off or the
 * location is not remote. The sources' prefilter uses it, so it drops exactly the remote postings scoreJob would.
 */
export function remoteOpenToCandidate(location: string, cfg: MatchSettings = config): boolean | 'not-remote' {
  if (!cfg.remote.enabled) return 'not-remote';
  const region = remoteRegion(location);
  if (region === null) return 'not-remote';
  return regionOpen(region, remoteRules(cfg).allow);
}

/** 'RM' = remote job that can be done from the candidate's country. Returns a reason when it is limited to other regions. */
function remoteCountry(
  cfg: MatchSettings,
  location: string,
  description: string,
): { country: string | null; reason?: string; flag?: string } | null {
  if (!cfg.remote.enabled) return null;
  const region = remoteRegion(location);
  if (region === null) return null;
  const { allow, deny, flag: flagRe } = remoteRules(cfg);
  // "Remote — Dubai" means living in Dubai: treat as an on-site country, not as remote from the candidate's country.
  for (const [code, c] of Object.entries(cfg.countries)) {
    if (re(c.match).test(region) && !allow.test(region)) return { country: code };
  }
  if (!regionOpen(region, allow)) {
    if (deny.test(region)) return { country: null, reason: `remote, but only for: ${region.slice(0, 80)}` };
    return { country: null, reason: `remote, region does not include ${fromName(cfg)}: ${region.slice(0, 80)}` };
  }
  const hit = description.match(REMOTE_DESC_DENY);
  if (hit) return { country: null, reason: `remote, but: "${hit[0].slice(0, 80)}"` };
  const flag = !region || flagRe.test(region) ? `remote region "${region || 'not stated'}" — confirm ${fromName(cfg)} is OK` : undefined;
  return { country: 'RM', flag };
}

function findCountry(cfg: MatchSettings, location: string, description: string): string | null {
  for (const [code, c] of Object.entries(cfg.countries)) {
    if (re(c.match).test(location)) return code;
  }
  // Remote / hybrid roles that name a target country only in the description.
  if (/remote|anywhere|emea|middle east|mena|gcc|europe/i.test(location)) {
    for (const [code, c] of Object.entries(cfg.countries)) {
      if (re(`(based|located|office|hub) in [^.\\n]{0,30}(${c.match})`).test(description)) return code;
    }
  }
  return null;
}

/** Scores a posting against the settings (default: the CLI's config.json) and the candidate's profile and CV. */
export function scoreJob(job: RawJob, cfg: MatchSettings = config): Scored {
  const text = `${job.title}\n${job.description}`;
  const remote = remoteCountry(cfg, job.location, job.description);
  const country = remote ? remote.country : findCountry(cfg, job.location, job.description);
  const flags: string[] = remote?.flag ? [remote.flag] : [];
  const aimedAtAi = instructionFlag(job.description);
  if (aimedAtAi) flags.push(aimedAtAi);
  const out = (filterReason: string | null, extra: Partial<Scored> = {}): Scored => ({
    country,
    score: 0,
    cluster: 'default',
    matched: [],
    missing: [],
    visa: null,
    visaEvidence: null,
    flags,
    filterReason,
    ...extra,
  });

  if (remote?.reason) return out(remote.reason);
  if (!country) return out(`location not in target countries (${job.location || 'unknown'})`);
  if (!re(cfg.roleInclude).test(job.title)) return out('title is not an engineering role');
  if (re(cfg.roleExclude).test(job.title)) return out('title excluded (other stack / non-dev / level)');

  const jobType = jobTypeOf(job.description);
  if (jobType && (cfg.skipJobTypes ?? DEFAULT_SKIP_JOB_TYPES).includes(jobType.type)) return out(`job type: ${jobType.line}`);

  // Re-checked on every fetch, so a matching job drops out once it gets older than maxAgeDays.
  if (job.posted_at) {
    const days = Math.floor((Date.now() - new Date(job.posted_at).getTime()) / 86_400_000);
    if (days > cfg.maxAgeDays) return out(`posted ${days} days ago (older than ${cfg.maxAgeDays} days)`);
  } else {
    flags.push('posting date unknown');
  }

  const lang = languageRules(loadProfile().languages);
  const langHit = text.match(lang.required);
  if (langHit) return out(`language required: "${langHit[0].slice(0, 80)}"`);
  if (lang.bonus.test(text)) flags.push('local language is a plus');

  // Remote from the candidate's country: no visa involved, so sponsorship wording doesn't matter.
  let visa: string | null = null;
  if (country === 'RM') {
    // A clearance is tied to the employer's country, so a remote job that needs one is not open from elsewhere.
    const clearance = text.match(CLEARANCE);
    if (clearance) return out(`needs a security clearance: "${clearance[0].slice(0, 80)}"`);
    const from = remoteFrom(cfg, loadProfile());
    visa = from ? `Remote: work from ${from}, no visa needed` : 'Remote: no visa needed';
    return skillScore(cfg, job, text, { country, visa, visaEvidence: 'not-needed', flags }, out);
  }

  // A country the candidate may already work in (or lives in): no sponsorship needed.
  const c = cfg.countries[country];
  if (!needsVisa(cfg, country, loadProfile())) {
    visa = `${c.name}: no visa needed`;
    return skillScore(cfg, job, text, { country, visa, visaEvidence: 'not-needed', flags }, out);
  }

  const onlySome = text.match(CLEARANCE) ?? text.match(CITIZENS_ONLY);
  if (onlySome) return out(`only for citizens, residents or cleared staff: "${onlySome[0].slice(0, 80)}"`);
  const noSponsor = text.match(NO_SPONSOR);
  if (noSponsor) return out(`no visa sponsorship: "${noSponsor[0].slice(0, 80)}"`);

  // Visa reasoning per country. Only the posting itself counts as "offered": a country's usual practice (employer
  // visas in the Gulf) or a sponsor register says the company could sponsor, not that it will for this job.
  const offered = SPONSOR.test(text);
  let onRegister: boolean | null = null;
  if (c.visa === 'ind-register') {
    onRegister = isIndSponsor(job.company, cfg.companies);
    if (onRegister === null) flags.push('IND register not downloaded (run sponsors:update)');
    else if (!onRegister) flags.push('company name not found on IND register — verify manually');
  }
  if (offered) visa = `${c.name}: posting offers visa/relocation support${onRegister ? ' (IND recognised sponsor)' : ''}`;
  else if (onRegister) visa = `${c.name}: company is an IND recognised sponsor, but the posting does not mention visa or relocation`;
  else if (c.visa === 'employer')
    visa = `${c.name}: posting does not mention visa or relocation (employers there usually sponsor the work visa)`;
  if (c.visa === 'ind-register' && !offered && !onRegister) return out('NL job but company not on IND sponsor register', { visa });
  const visaEvidence: VisaEvidence = offered ? 'offered' : onRegister ? 'can-sponsor' : 'silent';

  return skillScore(cfg, job, text, { country, visa, visaEvidence, flags }, out);
}

function skillScore(
  cfg: MatchSettings,
  job: RawJob,
  text: string,
  { country, visa, visaEvidence, flags }: { country: string; visa: string | null; visaEvidence: VisaEvidence; flags: string[] },
  out: (reason: string, extra?: Partial<Scored>) => Scored,
): Scored {
  const matched: string[] = [];
  const missing: string[] = [];
  let got = 0;
  let total = 0;
  for (const s of loadSkills(cfg)) {
    if (!s.re.test(text)) continue;
    const w = s.weight ?? 1;
    total += w;
    if (s.have) {
      got += w;
      matched.push(s.name);
    } else missing.push(s.name);
  }
  if (total === 0) return out('no recognisable tech stack in posting', { visa, visaEvidence });

  let score = Math.round((got / total) * 100);
  // Postings that only mention 1-2 generic skills shouldn't score 100.
  if (matched.length < 3) score = Math.min(score, 50);

  const years = [...text.matchAll(/(\d{1,2})\+?\s*(?:-\s*\d+\s*)?years/gi)].map((m) => Number(m[1])).filter((n) => n < 20);
  if (years.length && Math.max(...years) > 10) {
    score -= 15;
    flags.push(`asks ${Math.max(...years)}+ years`);
  }
  if (/\b(senior|sr\.?|lead|staff)\b/i.test(job.title)) score += 5;
  if (/\bjunior|\bjr\b|entry/i.test(job.title)) {
    score -= 20;
    flags.push('junior role');
  }
  score = Math.max(0, Math.min(100, score));

  if (score < cfg.minScore) return out(`score ${score} below minScore ${cfg.minScore}`, { score, matched, missing, visa, visaEvidence });

  return { country, score, cluster: pickCluster(text, cfg), matched, missing, visa, visaEvidence, flags, filterReason: null };
}

/** The most specific CV variant for a posting (the active stacks' clusters). Falls back to the untouched default CV. */
export function pickCluster(text: string, cfg: StackSettings = config): string {
  const hit = loadClusters(cfg).find((c) => c.all.every((r) => r.test(text)) && !c.none.some((r) => r.test(text)));
  return hit?.id ?? 'default';
}
