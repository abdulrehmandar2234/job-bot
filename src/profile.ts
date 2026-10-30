import { existsSync, readFileSync } from 'node:fs';
import { APPLICANT_EXAMPLE_FILE, applicantFile, loadSettings, masterFile, type Applicant, type Config } from './settings.ts';

// The candidate's profile: the personal facts that letters, prompts and filters need (name, contact, where they live,
// languages, relocation). It comes from cv/applicant.json; name and contact fall back to cv/master.json, so a CV alone
// already signs letters correctly. Nothing here is hardcoded for one person: `npm run bot -- setup` fills it in.
// The dashboard reads the same files itself (web/lib/profile.ts and web/lib/market.ts, kept in step by
// web/tests/lib/market.test.ts).

export type MasterContact = {
  name?: string;
  title?: string; // "Senior Full Stack Engineer"
  contact?: { phone?: string; email?: string; location?: string; linkedin?: string };
};

export type Profile = {
  fullName: string | null;
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  location: string | null; // "Lahore, Pakistan": city + country, else currentLocation, else the CV's location
  countryCode: string | null; // where the candidate lives
  country: string | null;
  utcOffset: string | null; // "GMT+5"
  languages: string[]; // ["English", "Urdu"]
  relocate: boolean | null; // null = not stated
  letter: { intro: string | null; pitch: Record<string, string>; strengths: string | null; remote: string | null };
};

/** A non-empty string value, or null. */
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** "English, Urdu and Arabic" / "English/Urdu" -> ["English", "Urdu", "Arabic"]. */
export function splitLanguages(v: unknown): string[] {
  const s = str(v);
  if (!s) return [];
  return s
    .split(/\s*(?:,|\/|;|\band\b|&)\s*/i)
    .map((x) => x.replace(/\(.*?\)/g, '').trim())
    .filter(Boolean);
}

/** True for `true` or a text starting with "yes", false for `false` or "no...", null when unknown. */
export function yesNo(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = str(v);
  if (!s) return null;
  if (/^(yes|y|true)\b|^open to\b/i.test(s)) return true;
  if (/^(no|n|false|not)\b/i.test(s)) return false;
  return null;
}

/** The profile from applicant facts plus the master CV's name and contact. Pure, so the dashboard can mirror it. */
export function buildProfile(app: Applicant | Record<string, unknown>, master: MasterContact = {}): Profile {
  const a = app as Record<string, unknown>;
  const c = master.contact ?? {};
  const city = str(a.city);
  const country = str(a.country);
  const letter = (a.coverLetter && typeof a.coverLetter === 'object' ? a.coverLetter : {}) as Record<string, unknown>;
  const pitch = letter.pitch && typeof letter.pitch === 'object' ? (letter.pitch as Record<string, unknown>) : {};
  return {
    fullName: str(a.fullName) ?? str(master.name),
    email: str(a.email) ?? str(c.email),
    phone: str(a.phone) ?? str(c.phone),
    linkedin: str(a.linkedin) ?? str(c.linkedin),
    location: city && country ? `${city}, ${country}` : (str(a.currentLocation) ?? str(c.location) ?? city ?? country),
    countryCode: str(a.countryCode)?.toUpperCase() ?? null,
    country,
    utcOffset: str(a.utcOffset),
    languages: splitLanguages(a.languages),
    relocate: yesNo(a.willingToRelocate),
    letter: {
      intro: str(letter.intro),
      pitch: Object.fromEntries(Object.entries(pitch).filter(([, v]) => str(v)) as [string, string][]),
      strengths: str(letter.strengths),
      remote: str(letter.remote),
    },
  };
}

/** Profile fields the bot needs before its letters and filters are personal. Same list in web/lib/profile.ts. */
export const REQUIRED_PROFILE = ['fullName', 'email', 'location', 'countryCode', 'languages'] as const;

/** Which required fields are still empty (after the CV fallbacks). Empty = the profile is complete. */
export function profileGaps(p: Profile): (typeof REQUIRED_PROFILE)[number][] {
  return REQUIRED_PROFILE.filter((k) => {
    const v = p[k];
    return Array.isArray(v) ? v.length === 0 : !v;
  });
}

// ---- Target markets (config.json) ----

/** The country remote jobs are done from: remote.from, else linkedin.remoteFrom, else the profile's country. */
export function remoteFrom(cfg: Pick<Config, 'remote' | 'linkedin'>, p: Pick<Profile, 'country'>): string | null {
  return str(cfg.remote.from) ?? str(cfg.linkedin?.remoteFrom) ?? p.country;
}

/** ISO code of that country: remote.fromCode, else the profile's countryCode. */
export function remoteFromCode(cfg: Pick<Config, 'remote'>, p: Pick<Profile, 'countryCode'>): string | null {
  return str(cfg.remote.fromCode) ?? p.countryCode;
}

/** Whether the candidate needs a work visa for onsite jobs in this target country (missing = yes). */
export function needsVisa(cfg: Pick<Config, 'countries'>, code: string, p?: Pick<Profile, 'countryCode'>): boolean {
  if (p?.countryCode && p.countryCode === code) return false;
  return cfg.countries[code]?.needsVisa !== false;
}

/** "A", "A and B", "A, B and C". */
export function listText(items: string[], and = 'and'): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} ${and} ${items.at(-1)}`;
}

/** "Lahore, Pakistan (GMT+5)", or what is known of it. */
export function whereText(p: Pick<Profile, 'location' | 'utcOffset'>): string | null {
  if (!p.location) return null;
  return p.utcOffset ? `${p.location} (${p.utcOffset})` : p.location;
}

// ---- Sentences shared by the template letters and the AI prompts ----

/** The signature block: name, "phone | email", LinkedIn; lines that are unknown are left out. */
export function signature(p: Pick<Profile, 'fullName' | 'phone' | 'email' | 'linkedin'>): string {
  const contact = [p.phone, p.email].filter(Boolean).join(' | ');
  return ['Best regards,', p.fullName, contact, p.linkedin].filter(Boolean).join('\n');
}

/** Facts about an onsite job in a target country: does the candidate live there, relocate, need a visa. */
export function onsiteSituation(cfg: Pick<Config, 'countries'>, p: Profile, code: string | null) {
  const home = !!code && !!p.countryCode && code === p.countryCode;
  return { home, relocate: !home && p.relocate === true, visa: !home && needsVisa(cfg, code ?? '', p) };
}

// ---- Loading ----

// applicantFile() / masterFile() read the environment on every call, so tests can point JOB_BOT_APPLICANT at a fixture.

/** cv/applicant.json, validated. Missing = all unknown (the example file's keys, every value null). */
export function readApplicant(): Applicant {
  const file = applicantFile();
  if (existsSync(file)) return loadSettings('applicant', file);
  return blankApplicant();
}

/** The example file's shape with every fact unknown: never the example person's placeholder values. */
export function blankApplicant(): Applicant {
  const ex = existsSync(APPLICANT_EXAMPLE_FILE)
    ? (JSON.parse(readFileSync(APPLICANT_EXAMPLE_FILE, 'utf8')) as Record<string, unknown>)
    : {};
  const blank = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blank(x)])) : null;
  const out = blank(ex) as Record<string, unknown>;
  out._help = typeof ex._help === 'string' ? ex._help : '';
  out.other = {};
  if (out.coverLetter) out.coverLetter = { pitch: {} };
  return out as Applicant;
}

export function readMaster(): MasterContact {
  try {
    return JSON.parse(readFileSync(masterFile(), 'utf8')) as MasterContact;
  } catch {
    return {};
  }
}

let cache: { key: string; profile: Profile } | null = null;

/** The current profile. Cached per applicant file, so the filters can call it for every posting. */
export function loadProfile(): Profile {
  const key = `${applicantFile()}|${masterFile()}`;
  if (cache?.key !== key) cache = { key, profile: buildProfile(readApplicant(), readMaster()) };
  return cache.profile;
}
