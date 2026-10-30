import { config } from './config.ts';
import { masterRaw } from './cv/versions.ts';
import { loadProfile, needsVisa, remoteFrom } from './profile.ts';
import { isIndSponsor } from './sponsors.ts';
import type { RawJob } from './sources/index.ts';
import type { VisaEvidence } from './types.ts';

type Skill = { name: string; re: RegExp; have: boolean; weight?: number; cv?: RegExp };

/** The skill items of cv/master.json, one per line: what `have` is checked against. */
function cvSkills(): string {
  try {
    const cv = JSON.parse(masterRaw()) as { skills?: { items: string[] }[] };
    return (cv.skills ?? []).flatMap((g) => g.items).join('\n');
  } catch {
    return '';
  }
}

/**
 * Marks each skill as on the CV (`have`) when its pattern, or its `cv` pattern, matches a skill listed in
 * cv/master.json. So `have` always follows the CV and is never claimed by hand.
 */
export function withCv<T extends Omit<Skill, 'have'>>(skills: T[], cvText: string): (T & { have: boolean })[] {
  return skills.map((s) => ({ ...s, have: s.re.test(cvText) || !!s.cv?.test(cvText) }));
}

// Skills we look for in job descriptions; `cv` = other CV wording that also proves it (MySQL proves SQL).
const SKILL_PATTERNS: Omit<Skill, 'have'>[] = [
  { name: 'PHP', re: /\bphp\b/i },
  { name: 'Laravel', re: /\blaravel\b/i, weight: 2 },
  { name: 'Livewire', re: /\blivewire\b/i },
  { name: 'Filament', re: /\bfilament(php)?\b/i },
  { name: 'Inertia.js', re: /\binertia/i },
  { name: 'Alpine.js', re: /\balpine(\.?js)?\b/i },
  { name: 'JavaScript', re: /\bjavascript\b|\bes6\b/i },
  { name: 'TypeScript', re: /\btypescript\b|\bts\b/i, weight: 2 },
  { name: 'Node.js', re: /\bnode(\.?js)?\b/i, weight: 2 },
  { name: 'NestJS', re: /\bnest\.?js\b|\bnestjs\b/i, weight: 2 },
  { name: 'Express.js', re: /\bexpress(\.?js)?\b/i },
  { name: 'React', re: /\breact(\.?js)?\b/i, weight: 2 },
  { name: 'Next.js', re: /\bnext\.?js\b/i, weight: 2 },
  { name: 'Redux', re: /\bredux\b/i },
  { name: 'Vue.js', re: /\bvue(\.?js)?\b|\bnuxt/i },
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
];

export const SKILLS: Skill[] = withCv(SKILL_PATTERNS, cvSkills());

// Which CV version (cluster) fits a job. 'default' = the original PDF, untouched.
const CLUSTERS: { id: string; re: RegExp[] }[] = [
  { id: 'ai-fullstack', re: [/\bllms?\b|\bopenai\b|generative ai|\bgenai\b|\bai agents?\b/i] },
  { id: 'laravel', re: [/\blaravel\b|\bphp\b/i] },
  { id: 'tall', re: [/\blivewire\b|\balpine|\btailwind/i, /\blaravel\b/i] },
  { id: 'laravel-vue', re: [/\bvue/i, /\blaravel\b|\bphp\b/i] },
  { id: 'next-nest', re: [/\bnest\.?js\b|\bnestjs\b/i, /\bnext\.?js\b|\breact\b/i] },
  { id: 'mern', re: [/\bmongo/i, /\breact\b/i, /\bnode|\bexpress/i] },
  { id: 'pern', re: [/\bpostgres/i, /\breact\b/i, /\bnode|\bexpress/i] },
  { id: 'backend-node', re: [/\bnode(\.?js)?\b|\bnest/i] },
  { id: 'frontend-react', re: [/\breact\b|\bnext\.?js\b/i] },
];

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

/** The "language required" and "language is a plus" patterns for the languages the candidate does not speak. */
export function languageRules(spoken: string[]): { required: RegExp; bonus: RegExp } {
  const known = new Set(spoken.map((l) => l.toLowerCase()));
  const req = LOCAL_LANGUAGES.filter((l) => !known.has(l)).join('|');
  const bonus = BONUS_LANGUAGES.filter((l) => !known.has(l)).join('|');
  return {
    required: req
      ? new RegExp(
          `(fluent|fluency|native|proficien\\w*|excellent|strong|business[- ]level|professional)[^.\\n]{0,40}\\b(${req})\\b(?![^.\\n]{0,40}(is a plus|is a bonus|nice to have|preferred|advantage|beneficial))|\\b(${req})\\b[^.\\n]{0,25}\\b(required|mandatory|is a must|must)\\b`,
          'i',
        )
      : NEVER,
    bonus: bonus ? new RegExp(`\\b(${bonus})\\b[^.\\n]{0,40}(plus|bonus|nice to have|preferred|advantage|beneficial)`, 'i') : NEVER,
  };
}
const NO_SPONSOR =
  /(no|not|unable to|cannot|can't|don't|do not)\s[^.\n]{0,30}(visa )?sponsor|must (already )?have (the )?(right|authori[sz]ation|permit) to work|eu (work )?(permit|passport|citizen)|without (the need for )?sponsorship|local candidates only|saudi nationals only|saudization|uae nationals only|emirati(s)? only|emiratisation/i;
const SPONSOR =
  /visa sponsorship|sponsor (your |a )?visa|relocation (support|package|assistance)|we (will )?(help|support) (you )?(with )?relocat|work permit support/i;

// Strong "you must live in X" phrases; plain mentions of the US or EU in a description prove nothing.
const REMOTE_DESC_DENY =
  /\b(us|u\.s\.|uk|eu)[- ]based (candidates|applicants|only)|must (be|reside|live)[^.\n]{0,30}\b(in|within) the (us|u\.s\.|united states|uk|united kingdom|eu|european union)\b|authori[sz]ed to work in the (us|united states|uk|united kingdom)|(only|exclusively) (hiring|accepting)[^.\n]{0,30}(us|united states|europe|latam|latin america)|us time ?zones? (only|required)/i;

/** The remote-from country for messages: "Pakistan", or "your country" when the profile does not say. */
const fromName = () => remoteFrom(config, loadProfile()) ?? 'your country';

/** 'RM' = remote job that can be done from the candidate's country. Returns a reason when it is limited to other regions. */
function remoteCountry(location: string, description: string): { country: string | null; reason?: string; flag?: string } | null {
  if (!config.remote.enabled || !/\bremote\b|anywhere|worldwide|work from home/i.test(location)) return null;
  const region = location.replace(/\bremote\b|[—–\-(),:|/]/gi, ' ').trim();
  // "Remote — Dubai" means living in Dubai: treat as an on-site country, not as remote from the candidate's country.
  for (const [code, c] of Object.entries(config.countries)) {
    if (new RegExp(c.match, 'i').test(region) && !new RegExp(config.remote.allow, 'i').test(region)) return { country: code };
  }
  const allow = new RegExp(config.remote.allow, 'i');
  const deny = new RegExp(config.remote.deny, 'i');
  const flagRe = new RegExp(config.remote.flag, 'i');
  if (region && !/not stated/i.test(region)) {
    if (!allow.test(region) && deny.test(region)) return { country: null, reason: `remote, but only for: ${region.slice(0, 80)}` };
    if (!allow.test(region)) return { country: null, reason: `remote, region does not include ${fromName()}: ${region.slice(0, 80)}` };
  }
  const hit = description.match(REMOTE_DESC_DENY);
  if (hit) return { country: null, reason: `remote, but: "${hit[0].slice(0, 80)}"` };
  const flag = !region || flagRe.test(region) ? `remote region "${region || 'not stated'}" — confirm ${fromName()} is OK` : undefined;
  return { country: 'RM', flag };
}

function findCountry(location: string, description: string): string | null {
  for (const [code, c] of Object.entries(config.countries)) {
    if (new RegExp(c.match, 'i').test(location)) return code;
  }
  // Remote / hybrid roles that name a target country only in the description.
  if (/remote|anywhere|emea|middle east|mena|gcc|europe/i.test(location)) {
    for (const [code, c] of Object.entries(config.countries)) {
      if (new RegExp(`(based|located|office|hub) in [^.\\n]{0,30}(${c.match})`, 'i').test(description)) return code;
    }
  }
  return null;
}

export function scoreJob(job: RawJob): Scored {
  const text = `${job.title}\n${job.description}`;
  const remote = remoteCountry(job.location, job.description);
  const country = remote ? remote.country : findCountry(job.location, job.description);
  const flags: string[] = remote?.flag ? [remote.flag] : [];
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
  if (!new RegExp(config.roleInclude, 'i').test(job.title)) return out('title is not an engineering role');
  if (new RegExp(config.roleExclude, 'i').test(job.title)) return out('title excluded (other stack / non-dev / level)');

  // Re-checked on every fetch, so a matching job drops out once it gets older than maxAgeDays.
  if (job.posted_at) {
    const days = Math.floor((Date.now() - new Date(job.posted_at).getTime()) / 86_400_000);
    if (days > config.maxAgeDays) return out(`posted ${days} days ago (older than ${config.maxAgeDays} days)`);
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
    const from = remoteFrom(config, loadProfile());
    visa = from ? `Remote: work from ${from}, no visa needed` : 'Remote: no visa needed';
    return skillScore(job, text, { country, visa, visaEvidence: 'not-needed', flags }, out);
  }

  // A country the candidate may already work in (or lives in): no sponsorship needed.
  const c = config.countries[country];
  if (!needsVisa(config, country, loadProfile())) {
    visa = `${c.name}: no visa needed`;
    return skillScore(job, text, { country, visa, visaEvidence: 'not-needed', flags }, out);
  }

  const noSponsor = text.match(NO_SPONSOR);
  if (noSponsor) return out(`no visa sponsorship: "${noSponsor[0].slice(0, 80)}"`);

  // Visa reasoning per country. Only the posting itself counts as "offered": a country's usual practice (employer
  // visas in the Gulf) or a sponsor register says the company could sponsor, not that it will for this job.
  const offered = SPONSOR.test(text);
  let onRegister: boolean | null = null;
  if (c.visa === 'ind-register') {
    onRegister = isIndSponsor(job.company);
    if (onRegister === null) flags.push('IND register not downloaded (run sponsors:update)');
    else if (!onRegister) flags.push('company name not found on IND register — verify manually');
  }
  if (offered) visa = `${c.name}: posting offers visa/relocation support${onRegister ? ' (IND recognised sponsor)' : ''}`;
  else if (onRegister) visa = `${c.name}: company is an IND recognised sponsor, but the posting does not mention visa or relocation`;
  else if (c.visa === 'employer')
    visa = `${c.name}: posting does not mention visa or relocation (employers there usually sponsor the work visa)`;
  if (c.visa === 'ind-register' && !offered && !onRegister) return out('NL job but company not on IND sponsor register', { visa });
  const visaEvidence: VisaEvidence = offered ? 'offered' : onRegister ? 'can-sponsor' : 'silent';

  return skillScore(job, text, { country, visa, visaEvidence, flags }, out);
}

function skillScore(
  job: RawJob,
  text: string,
  { country, visa, visaEvidence, flags }: { country: string; visa: string | null; visaEvidence: VisaEvidence; flags: string[] },
  out: (reason: string, extra?: Partial<Scored>) => Scored,
): Scored {
  const matched: string[] = [];
  const missing: string[] = [];
  let got = 0;
  let total = 0;
  for (const s of SKILLS) {
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

  if (score < config.minScore)
    return out(`score ${score} below minScore ${config.minScore}`, { score, matched, missing, visa, visaEvidence });

  return { country, score, cluster: pickCluster(text), matched, missing, visa, visaEvidence, flags, filterReason: null };
}

/** The most specific CV variant for a posting. Falls back to the untouched default CV. */
export function pickCluster(text: string): string {
  const php = /\blaravel\b|\bphp\b/i.test(text);
  const js = /\bnode|\breact\b|\bnext\.?js|\bnest/i.test(text);
  // A posting asking for both Laravel and JS stacks is exactly what the default CV already says.
  if (php && js && !/\blivewire|\bvue/i.test(text)) return 'default';
  // LLM experience is the strongest differentiator, so it wins over plain stack clusters.
  if (js && CLUSTERS[0].re[0].test(text)) return 'ai-fullstack';
  const hits = CLUSTERS.filter((c) => c.re.every((r) => r.test(text)));
  // Prefer clusters with more conditions (more specific), keep list order on ties.
  hits.sort((a, b) => b.re.length - a.re.length);
  return hits[0]?.id ?? 'default';
}
