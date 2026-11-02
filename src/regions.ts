// Which remote jobs a candidate can take, from the country they work from (remote.fromCode, else the profile's
// countryCode). A remote posting names where it is open ("Remote — Worldwide", "Remote, India", "EMEA"); these rules
// turn the candidate's country into the three patterns src/match.ts tests that text with:
//   allow: open to the candidate (worldwide, their country, a region it is in, its time zone),
//   deny:  limited to somewhere else (another country, a region it is not in),
//   flag:  open, but broad enough to confirm before applying (EMEA, "international", no region given).
// remote.allow / remote.deny / remote.flag in config.json, when set, replace the computed pattern.

/** Region words, as regular expressions. A posting limited to a region the candidate is not in is denied. */
const REGIONS = {
  southAsia: 'south asia',
  asia: '\\basia\\b',
  apac: 'apac|asia[- ]pacific',
  mena: '\\bmena\\b|middle east|\\bgcc\\b',
  emea: '\\bemea\\b',
  africa: '\\bafrica\\b',
  europe: 'europe|\\beu\\b|european union|\\beea\\b',
  northAmerica: 'north america|\\bamericas\\b',
  latam: 'latam|latin america|south america',
} as const;

type Region = keyof typeof REGIONS;

/** Always open: no region at all. */
const WORLDWIDE = 'worldwide|anywhere|global|international';

/** Regions so wide that "open to EMEA" may still not mean every country in it. */
const BROAD: Region[] = ['emea'];

type Country = { names: string; regions: Region[]; tz?: string };

const EUROPE: Region[] = ['europe', 'emea'];

/** Countries remote postings often name, by ISO code. A country missing here gets worldwide jobs only. */
export const COUNTRIES: Record<string, Country> = {
  PK: { names: 'pakistan', regions: ['southAsia', 'asia', 'apac', 'mena', 'emea'], tz: '(gmt|utc) ?\\+ ?0?5(?! ?[:.]? ?30)|\\bpkt\\b' },
  IN: { names: 'india', regions: ['southAsia', 'asia', 'apac'], tz: '(gmt|utc) ?\\+ ?0?5 ?[:.]? ?30|\\bist\\b' },
  BD: { names: 'bangladesh', regions: ['southAsia', 'asia', 'apac'], tz: '(gmt|utc) ?\\+ ?0?6\\b' },
  LK: { names: 'sri lanka', regions: ['southAsia', 'asia', 'apac'] },
  NP: { names: 'nepal', regions: ['southAsia', 'asia', 'apac'] },
  AE: { names: 'united arab emirates|\\buae\\b|dubai', regions: ['mena', 'emea'] },
  SA: { names: 'saudi|\\bksa\\b', regions: ['mena', 'emea'] },
  EG: { names: 'egypt', regions: ['mena', 'emea', 'africa'] },
  TR: { names: 'turkey|t[uü]rkiye', regions: ['emea'] },
  NG: { names: 'nigeria', regions: ['africa', 'emea'] },
  KE: { names: 'kenya', regions: ['africa', 'emea'] },
  ZA: { names: 'south africa', regions: ['africa', 'emea'] },
  PH: { names: 'philippines', regions: ['asia', 'apac'] },
  ID: { names: 'indonesia', regions: ['asia', 'apac'] },
  MY: { names: 'malaysia', regions: ['asia', 'apac'] },
  VN: { names: 'vietnam', regions: ['asia', 'apac'] },
  SG: { names: 'singapore', regions: ['asia', 'apac'] },
  AU: { names: 'australia', regions: ['apac'] },
  NZ: { names: 'new zealand', regions: ['apac'] },
  GB: { names: '\\buk\\b|united kingdom|britain|england', regions: EUROPE },
  IE: { names: 'ireland', regions: EUROPE },
  NL: { names: 'netherlands|nederland', regions: EUROPE },
  DE: { names: 'germany', regions: EUROPE },
  FR: { names: 'france', regions: EUROPE },
  ES: { names: 'spain', regions: EUROPE },
  PT: { names: 'portugal', regions: EUROPE },
  IT: { names: 'italy', regions: EUROPE },
  PL: { names: 'poland', regions: EUROPE },
  RO: { names: 'romania', regions: EUROPE },
  UA: { names: 'ukraine', regions: EUROPE },
  US: { names: '\\b(us|usa|u\\.s\\.?)\\b|united states', regions: ['northAmerica'] },
  CA: { names: 'canada', regions: ['northAmerica'] },
  MX: { names: 'mexico', regions: ['latam', 'northAmerica'] },
  BR: { names: 'brazil', regions: ['latam'] },
  AR: { names: 'argentina', regions: ['latam'] },
  CO: { names: 'colombia', regions: ['latam'] },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type RemoteRules = { allow: string; deny: string; flag: string };

/**
 * The allow / deny / flag patterns for a candidate working from this country (ISO code, any case). `name` is the
 * country as the candidate wrote it (remote.from), allowed too when the table spells it differently or lacks it.
 */
export function remoteRules(code: string | null | undefined, name?: string | null): RemoteRules {
  const home = code ? COUNTRIES[code.toUpperCase()] : undefined;
  const mine = new Set<Region>(home?.regions ?? []);
  const typed = name?.trim().toLowerCase() ?? '';
  const own = typed && !(home && new RegExp(home.names, 'i').test(typed)) ? esc(typed) : '';
  const allow = [WORLDWIDE, home?.names, own, ...[...mine].map((r) => REGIONS[r]), home?.tz].filter(Boolean);
  const others = Object.entries(COUNTRIES)
    .filter(([c]) => c !== code?.toUpperCase())
    .map(([, c]) => c.names)
    .filter((n) => !own || !new RegExp(n, 'i').test(own));
  const deny = [...others, ...(Object.keys(REGIONS) as Region[]).filter((r) => !mine.has(r)).map((r) => REGIONS[r])];
  const flag = ['international|not stated', ...BROAD.filter((r) => mine.has(r)).map((r) => REGIONS[r])];
  return { allow: allow.join('|'), deny: deny.join('|'), flag: flag.join('|') };
}

/** remote.allow / deny / flag from config.json where set, the computed rules for the candidate's country elsewhere. */
export function effectiveRemoteRules(
  remote: { allow?: string; deny?: string; flag?: string },
  code: string | null | undefined,
  name?: string | null,
): RemoteRules {
  const auto = remoteRules(code, name);
  const pick = (v: string | undefined, d: string) => (v?.trim() ? v : d);
  return { allow: pick(remote.allow, auto.allow), deny: pick(remote.deny, auto.deny), flag: pick(remote.flag, auto.flag) };
}
