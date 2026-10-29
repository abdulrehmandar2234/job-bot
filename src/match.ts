import { config } from './config.ts';
import { isIndSponsor } from './sponsors.ts';
import type { RawJob } from './sources/index.ts';

// Skills we look for in job descriptions. `have` = it is on the master CV.
// Never flip `have` to true for something that is not genuinely on the CV.
export const SKILLS: { name: string; re: RegExp; have: boolean; weight?: number }[] = [
  { name: 'PHP', re: /\bphp\b/i, have: true },
  { name: 'Laravel', re: /\blaravel\b/i, have: true, weight: 2 },
  { name: 'Livewire', re: /\blivewire\b/i, have: true },
  { name: 'Filament', re: /\bfilament(php)?\b/i, have: true },
  { name: 'Inertia.js', re: /\binertia/i, have: true },
  { name: 'Alpine.js', re: /\balpine(\.?js)?\b/i, have: true },
  { name: 'JavaScript', re: /\bjavascript\b|\bes6\b/i, have: true },
  { name: 'TypeScript', re: /\btypescript\b|\bts\b/i, have: true, weight: 2 },
  { name: 'Node.js', re: /\bnode(\.?js)?\b/i, have: true, weight: 2 },
  { name: 'NestJS', re: /\bnest\.?js\b|\bnestjs\b/i, have: true, weight: 2 },
  { name: 'Express.js', re: /\bexpress(\.?js)?\b/i, have: true },
  { name: 'React', re: /\breact(\.?js)?\b/i, have: true, weight: 2 },
  { name: 'Next.js', re: /\bnext\.?js\b/i, have: true, weight: 2 },
  { name: 'Redux', re: /\bredux\b/i, have: true },
  { name: 'Vue.js', re: /\bvue(\.?js)?\b|\bnuxt/i, have: true },
  { name: 'MongoDB', re: /\bmongo(db)?\b/i, have: true },
  { name: 'PostgreSQL', re: /\bpostgres(ql)?\b/i, have: true },
  { name: 'MySQL', re: /\bmysql\b|\bmariadb\b/i, have: true },
  { name: 'SQL', re: /\bsql\b/i, have: true },
  { name: 'Prisma', re: /\bprisma\b/i, have: true },
  { name: 'TypeORM', re: /\btypeorm\b/i, have: true },
  { name: 'GraphQL', re: /\bgraphql\b/i, have: true },
  { name: 'REST APIs', re: /\brest(ful)?\b|\bapis?\b/i, have: true },
  { name: 'OAuth/JWT', re: /\boauth\b|\bjwt\b/i, have: true },
  { name: 'AWS', re: /\baws\b|amazon web services/i, have: true },
  { name: 'Docker', re: /\bdocker\b|\bcontainers?\b/i, have: true },
  { name: 'CI/CD', re: /\bci\/?cd\b|continuous integration/i, have: true },
  { name: 'Testing', re: /\bjest\b|\bphpunit\b|\bpest\b|\bmocha\b|unit test|integration test|\btdd\b/i, have: true },
  {
    name: 'LLM / AI',
    re: /\bllms?\b|\bopenai\b|\bgpt\b|generative ai|\bgenai\b|\bai agents?\b|prompt engineering/i,
    have: true,
    weight: 2,
  },
  { name: 'Microservices', re: /\bmicroservices?\b/i, have: false },
  { name: 'Angular', re: /\bangular\b/i, have: false, weight: 2 },
  { name: 'Tailwind CSS', re: /\btailwind/i, have: true },
  { name: 'Kubernetes', re: /\bkubernetes\b|\bk8s\b/i, have: false },
  { name: 'Redis', re: /\bredis\b/i, have: false },
  { name: 'Kafka', re: /\bkafka\b/i, have: false },
  { name: 'Terraform', re: /\bterraform\b/i, have: false },
  { name: 'GCP', re: /\bgcp\b|google cloud/i, have: false },
  { name: 'Azure', re: /\bazure\b/i, have: false },
  { name: 'Python', re: /\bpython\b|\bdjango\b|\bfastapi\b/i, have: false, weight: 2 },
  { name: 'Go', re: /\bgolang\b/i, have: false, weight: 2 },
  { name: 'Java', re: /\bjava\b(?!script)|\bspring boot\b/i, have: false, weight: 2 },
  { name: 'Ruby', re: /\bruby\b|\brails\b/i, have: false, weight: 2 },
  { name: 'C#/.NET', re: /\bc#|\.net\b/i, have: false, weight: 2 },
];

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
  flags: string[];
  filterReason: string | null;
};

const LANG_REQUIRED =
  /(fluent|fluency|native|proficien\w*|excellent|strong|business[- ]level|professional)[^.\n]{0,40}\b(dutch|arabic|german|french)\b(?![^.\n]{0,40}(is a plus|is a bonus|nice to have|preferred|advantage|beneficial))|\b(dutch|arabic|german|french)\b[^.\n]{0,25}\b(required|mandatory|is a must|must)\b/i;
const LANG_BONUS = /\b(dutch|arabic)\b[^.\n]{0,40}(plus|bonus|nice to have|preferred|advantage|beneficial)/i;
const NO_SPONSOR =
  /(no|not|unable to|cannot|can't|don't|do not)\s[^.\n]{0,30}(visa )?sponsor|must (already )?have (the )?(right|authori[sz]ation|permit) to work|eu (work )?(permit|passport|citizen)|without (the need for )?sponsorship|local candidates only|saudi nationals only|saudization|uae nationals only|emirati(s)? only|emiratisation/i;
const SPONSOR =
  /visa sponsorship|sponsor (your |a )?visa|relocation (support|package|assistance)|we (will )?(help|support) (you )?(with )?relocat|work permit support/i;

// Strong "you must live in X" phrases; plain mentions of the US or EU in a description prove nothing.
const REMOTE_DESC_DENY =
  /\b(us|u\.s\.|uk|eu)[- ]based (candidates|applicants|only)|must (be|reside|live)[^.\n]{0,30}\b(in|within) the (us|u\.s\.|united states|uk|united kingdom|eu|european union)\b|authori[sz]ed to work in the (us|united states|uk|united kingdom)|(only|exclusively) (hiring|accepting)[^.\n]{0,30}(us|united states|europe|latam|latin america)|us time ?zones? (only|required)/i;

/** 'RM' = remote job that can be done from Pakistan. Returns a reason when a remote job is limited to other regions. */
function remoteCountry(location: string, description: string): { country: string | null; reason?: string; flag?: string } | null {
  if (!config.remote.enabled || !/\bremote\b|anywhere|worldwide|work from home/i.test(location)) return null;
  const region = location.replace(/\bremote\b|[—–\-(),:|/]/gi, ' ').trim();
  // "Remote — Dubai" means living in Dubai: treat as an on-site country, not as remote-from-Pakistan.
  for (const [code, c] of Object.entries(config.countries)) {
    if (new RegExp(c.match, 'i').test(region) && !new RegExp(config.remote.allow, 'i').test(region)) return { country: code };
  }
  const allow = new RegExp(config.remote.allow, 'i');
  const deny = new RegExp(config.remote.deny, 'i');
  const flagRe = new RegExp(config.remote.flag, 'i');
  if (region && !/not stated/i.test(region)) {
    if (!allow.test(region) && deny.test(region)) return { country: null, reason: `remote, but only for: ${region.slice(0, 80)}` };
    if (!allow.test(region)) return { country: null, reason: `remote, region does not include Pakistan: ${region.slice(0, 80)}` };
  }
  const hit = description.match(REMOTE_DESC_DENY);
  if (hit) return { country: null, reason: `remote, but: "${hit[0].slice(0, 80)}"` };
  const flag = !region || flagRe.test(region) ? `remote region "${region || 'not stated'}" — confirm Pakistan is OK` : undefined;
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

  const langHit = text.match(LANG_REQUIRED);
  if (langHit) return out(`language required: "${langHit[0].slice(0, 80)}"`);
  if (LANG_BONUS.test(text)) flags.push('local language is a plus');

  // Remote from Pakistan: no visa involved, so sponsorship wording doesn't matter.
  let visa: string | null = null;
  if (country === 'RM') {
    visa = 'Remote: work from Pakistan, no visa needed';
    return skillScore(job, text, { country, visa, flags }, out);
  }

  const noSponsor = text.match(NO_SPONSOR);
  if (noSponsor) return out(`no visa sponsorship: "${noSponsor[0].slice(0, 80)}"`);

  // Visa reasoning per country.
  const c = config.countries[country];
  if (c.visa === 'employer') visa = `${c.name}: employer issues work visa`;
  if (c.visa === 'ind-register') {
    const onRegister = isIndSponsor(job.company);
    if (onRegister) visa = 'NL: company is an IND recognised sponsor';
    else if (onRegister === null) flags.push('IND register not downloaded (run sponsors:update)');
    else flags.push('company name not found on IND register — verify manually');
  }
  if (SPONSOR.test(text)) visa = [visa, 'posting mentions visa/relocation support'].filter(Boolean).join('; ');
  if (c.visa === 'ind-register' && !visa) return out('NL job but company not on IND sponsor register', { visa });

  return skillScore(job, text, { country, visa, flags }, out);
}

function skillScore(
  job: RawJob,
  text: string,
  { country, visa, flags }: { country: string; visa: string | null; flags: string[] },
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
  if (total === 0) return out('no recognisable tech stack in posting', { visa });

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

  if (score < config.minScore) return out(`score ${score} below minScore ${config.minScore}`, { score, matched, missing, visa });

  return { country, score, cluster: pickCluster(text), matched, missing, visa, flags, filterReason: null };
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
