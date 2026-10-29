// Pure helpers for the settings forms, safe to import from client components (no node: modules).
// Type-only imports from the bot: erased at build time, so no bot code is bundled into the dashboard.
import type { Company, SettingsError, SettingsKind } from '../../src/settings';

export type { SettingsError, SettingsKind };
export type Json = Record<string, unknown>;

/** Same list as the bot's ATS (src/settings.ts); tests/lib/settings.test.ts checks they match. */
export const ATS: readonly Company['ats'][] = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday'];

// Form field names are the same paths the validator reports (`ai.enabled`, `companies[3].ats`), so errors map
// straight onto fields. Merging starts from the current file, so keys the form does not show are kept.

type FieldType = 'number' | 'bool' | 'text' | 'lines';

export const CONFIG_FIELDS: Record<string, FieldType> = {
  minScore: 'number', maxAgeDays: 'number', autoCvVersions: 'bool',
  roleInclude: 'text', roleExclude: 'text',
  'linkedin.enabled': 'bool', 'linkedin.keywords': 'lines', 'linkedin.locations': 'lines',
  'linkedin.remoteFrom': 'text', 'linkedin.pagesPerSearch': 'number',
  'remote.enabled': 'bool', 'remote.boards': 'lines', 'remote.himalayasQueries': 'lines',
  'remote.allow': 'text', 'remote.deny': 'text', 'remote.flag': 'text',
  'ai.enabled': 'bool', 'ai.alertStrong': 'bool', 'ai.scoreModel': 'text', 'ai.letterModel': 'text', 'ai.maxScorePerRun': 'number',
};

export const APPLICANT_FACTS = [
  'currentLocation', 'languages', 'needsVisaSponsorship', 'willingToRelocate', 'nationality', 'noticePeriod',
  'earliestStartDate', 'currentSalary', 'workingHoursForRemote', 'howDidYouHear',
] as const;
export const SALARY_KEYS = ['AE', 'SA', 'NL', 'remote'] as const;

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Value at a dotted path, e.g. get(cfg, 'ai.enabled'). */
export function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

function set(obj: Json, path: string, value: unknown) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) o[k] = {};
    o = o[k] as Json;
  }
  o[keys.at(-1)!] = value;
}

const str = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};

// An empty or non-numeric number field is passed on as is, so the validator reports it on that field.
function parse(type: FieldType, raw: string): unknown {
  if (type === 'lines') return raw.split('\n').map((s) => s.trim()).filter(Boolean);
  if (type === 'number') return raw.trim() === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  return raw.trim();
}

/** Indices of repeated rows (`companies[0].name`, `companies[1].name` ...) present in the form, in order. */
function rows(fd: FormData, list: string): number[] {
  const re = new RegExp(`^${list}\\[(\\d+)\\]\\.`);
  const idx = new Set<number>();
  for (const k of fd.keys()) {
    const m = re.exec(k);
    if (m) idx.add(Number(m[1]));
  }
  return [...idx].sort((a, b) => a - b);
}

export function mergeConfig(current: Json, fd: FormData): Json {
  const cfg = structuredClone(current);
  for (const [name, type] of Object.entries(CONFIG_FIELDS)) {
    // An unchecked checkbox is not sent at all.
    set(cfg, name, type === 'bool' ? fd.get(name) === 'on' : parse(type, str(fd, name)));
  }
  mergeAdzuna(cfg, fd);
  // Only the location patterns of existing countries are editable.
  if (isObj(cfg.countries)) {
    for (const [code, c] of Object.entries(cfg.countries)) {
      const name = `countries.${code}.match`;
      if (isObj(c) && fd.has(name)) c.match = str(fd, name).trim();
    }
  }
  // Each row says which original company it was (`orig`), so keys the form does not show (indName) survive edits.
  const before = Array.isArray(current.companies) ? current.companies : [];
  cfg.companies = rows(fd, 'companies').map((i) => {
    const p = `companies[${i}].`;
    const orig = before[Number(str(fd, p + 'orig') || -1)];
    return { ...(isObj(orig) ? orig : {}), name: str(fd, p + 'name').trim(), ats: str(fd, p + 'ats'), token: str(fd, p + 'token').trim() };
  });
  return cfg;
}

/**
 * The optional `adzuna` section. All three fields empty means no section (the bot then uses its defaults), so a
 * config without one never gets an empty, invalid one. Empty keywords = use the LinkedIn keywords.
 */
function mergeAdzuna(cfg: Json, fd: FormData) {
  if (!fd.has('adzuna.countries')) return;
  const countries = parse('lines', str(fd, 'adzuna.countries')) as string[];
  const keywords = parse('lines', str(fd, 'adzuna.keywords')) as string[];
  const pages = str(fd, 'adzuna.pagesPerSearch');
  if (!countries.length && !keywords.length && !pages.trim()) {
    delete cfg.adzuna;
    return;
  }
  const adzuna: Json = isObj(cfg.adzuna) ? cfg.adzuna : {};
  adzuna.countries = countries;
  adzuna.pagesPerSearch = parse('number', pages);
  if (keywords.length) adzuna.keywords = keywords;
  else delete adzuna.keywords;
  cfg.adzuna = adzuna;
}

/** An empty fact is null (unknown), so the AI writes [FILL: ...]. Unchanged values keep their type (e.g. booleans). */
function fact(before: unknown, raw: string): unknown {
  const v = raw.trim();
  if (!v) return null;
  return before != null && String(before) === v ? before : v;
}

export function mergeApplicant(current: Json, fd: FormData): Json {
  const app = structuredClone(current);
  for (const k of APPLICANT_FACTS) app[k] = fact(current[k], str(fd, k));
  const salary = isObj(app.expectedSalary) ? app.expectedSalary : {};
  for (const k of SALARY_KEYS) salary[k] = fact(salary[k], str(fd, `expectedSalary.${k}`));
  app.expectedSalary = salary;
  // `other` is shown in full, so a removed row removes its key.
  const before = isObj(current.other) ? current.other : {};
  const other: Json = {};
  for (const i of rows(fd, 'other')) {
    const key = str(fd, `other[${i}].key`).trim();
    if (key) other[key] = fact(before[key], str(fd, `other[${i}].value`));
  }
  app.other = other;
  return app;
}

/** Errors for one field: its own path, plus items of a one-per-line list (`linkedin.keywords[2]`). */
export const errorsFor = (errors: SettingsError[], name: string) =>
  errors.filter((e) => e.path === name || (e.path.startsWith(name + '[') && /^\[\d+\]$/.test(e.path.slice(name.length))));
