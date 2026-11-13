// Pure helpers for the settings forms, safe to import from client components (no node: modules). From the bot it
// imports only modules without I/O (src/ai-presets.ts, src/types.ts); settings.ts itself is type-only here.
import type { SettingsError, SettingsKind } from '../../src/settings';

export type { SettingsError, SettingsKind };
export type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- AI presets: the bot's own (src/ai-presets.ts has no imports, so client components can bundle it) ----

export {
  AI_KEY_ENV,
  API_PRESETS,
  detectPreset,
  LEGACY_KEY_ENV,
  PRESETS,
  RESPONSE_FORMATS,
  type ApiPreset,
  type Preset,
  type ResponseFormat,
} from '../../src/ai-presets.ts';

/** The provider select: "openai" / "deepseek" in config.json are older names for "api". */
export const isApiProvider = (v: unknown) => v === 'api' || v === 'openai' || v === 'deepseek';

/** The ATS and remote board lists the bot validates against (src/types.ts, importable from client components). */
export { ATS, DEFAULT_DAILY_TIME, DEFAULT_SKIP_JOB_TYPES, JOB_TYPES, REMOTE_BOARDS } from '../../src/types.ts';

// Form field names are the same paths the validator reports (`ai.enabled`, `companies[3].ats`), so errors map
// straight onto fields. Merging starts from the current file, so keys the form does not show are kept.

// optional: an empty field removes the key; code: optional, upper-cased (ISO country code).
type FieldType = 'number' | 'bool' | 'text' | 'lines' | 'optional' | 'code';

export const CONFIG_FIELDS: Record<string, FieldType> = {
  minScore: 'number',
  maxAgeDays: 'number',
  skipJobTypes: 'lines', // empty = keep every job type
  dailyTime: 'optional', // "HH:MM"; empty = 09:00, the built-in default (the key is left out)
  autoCvVersions: 'bool',
  cvTemplate: 'optional', // empty = classic, the built-in default (the key is left out)
  roleInclude: 'text',
  roleExclude: 'text',
  'linkedin.enabled': 'bool',
  'linkedin.keywords': 'lines',
  'linkedin.locations': 'lines',
  'linkedin.remoteFrom': 'text',
  'linkedin.pagesPerSearch': 'number',
  'remote.enabled': 'bool',
  'remote.boards': 'lines',
  'remote.himalayasQueries': 'lines',
  // Region patterns: empty = computed from the remote-from country (src/regions.ts).
  'remote.allow': 'optional',
  'remote.deny': 'optional',
  'remote.flag': 'optional',
  'remote.from': 'optional',
  'remote.fromCode': 'code',
  'ai.enabled': 'bool',
  'ai.alertStrong': 'bool',
  'ai.checkLetters': 'bool',
  'ai.scoreModel': 'text',
  'ai.letterModel': 'text',
  'ai.maxScorePerRun': 'number',
  // The API provider: empty = auto-detect the preset / the preset's base URL and models.
  'ai.api.preset': 'optional',
  'ai.api.baseUrl': 'optional',
  'ai.api.scoreModel': 'optional',
  'ai.api.letterModel': 'optional',
};

/** The profile part of cv/applicant.json (see src/profile.ts). */
export const PROFILE_FIELDS = [
  'fullName',
  'email',
  'phone',
  'linkedin',
  'city',
  'country',
  'countryCode',
  'utcOffset',
  'workAuthorization',
  'birthDate', // "1996-06-15", only for the Dutch IND salary check (src/ind-salary.ts)
] as const;

/** Sentences of the template cover letter; `pitch.default` is the pitch when no CV cluster has its own. */
export const LETTER_FIELDS = ['intro', 'pitch.default', 'strengths', 'remote'] as const;

export const APPLICANT_FACTS = [
  'currentLocation',
  'languages',
  'needsVisaSponsorship',
  'willingToRelocate',
  'nationality',
  'noticePeriod',
  'earliestStartDate',
  'currentSalary',
  'workingHoursForRemote',
  'howDidYouHear',
] as const;
/** Expected-salary keys: one per target country in config.json, plus "remote". */
export function salaryKeys(config: Json | null): string[] {
  const countries = isObj(config?.countries) ? Object.keys(config.countries) : [];
  return [...countries, 'remote'];
}

/** Value at a dotted path, e.g. get(cfg, 'ai.enabled'). */
export function get(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj);
}

/**
 * Sets a dotted path; `undefined` removes the key instead, and an object it leaves empty (`ai.api: {}`) too, so
 * clearing an optional field never adds a section the file did not have.
 */
function set(obj: Json, path: string, value: unknown) {
  const keys = path.split('.');
  const chain: Json[] = [obj];
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isObj(o[k])) {
      if (value === undefined) return;
      o[k] = {};
    }
    o = o[k] as Json;
    chain.push(o);
  }
  if (value !== undefined) {
    o[keys.at(-1)!] = value;
    return;
  }
  delete o[keys.at(-1)!];
  for (let i = chain.length - 1; i > 0 && !Object.keys(chain[i]).length; i--) delete chain[i - 1][keys[i - 1]];
}

const str = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v : '';
};

// An empty or non-numeric number field is passed on as is, so the validator reports it on that field.
function parse(type: FieldType, raw: string): unknown {
  if (type === 'lines')
    return raw
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  if (type === 'number') return raw.trim() === '' ? null : Number.isFinite(Number(raw)) ? Number(raw) : raw;
  if (type === 'code') return raw.trim().toUpperCase() || undefined;
  if (type === 'optional') return raw.trim() || undefined;
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
    // Optional keys a form does not show are kept as they are.
    if ((type === 'optional' || type === 'code') && !fd.has(name)) continue;
    // An unchecked checkbox is not sent at all.
    set(cfg, name, type === 'bool' ? fd.get(name) === 'on' : parse(type, str(fd, name)));
  }
  mergeAdzuna(cfg, fd);
  // The provider: missing means claude-cli, so choosing it only writes the key when the file already had one.
  if (fd.has('ai.provider')) {
    const v = str(fd, 'ai.provider').trim();
    const was = get(current, 'ai.provider');
    set(cfg, 'ai.provider', !v || (v === 'claude-cli' && was === undefined) ? undefined : v);
    // Saving an older "openai" / "deepseek" config as "api": the form showed that section's models in ai.api.
    if (v === 'api' && (was === 'openai' || was === 'deepseek')) set(cfg, `ai.${was}`, undefined);
  }
  // For existing countries: the location pattern, the dashboard label and whether a visa is needed.
  if (isObj(cfg.countries)) {
    for (const [code, c] of Object.entries(cfg.countries)) {
      const p = `countries.${code}.`;
      if (!isObj(c) || !fd.has(p + 'match')) continue;
      c.match = str(fd, p + 'match').trim();
      c.needsVisa = fd.get(p + 'needsVisa') === 'on';
      if (fd.has(p + 'label')) set(c, 'label', parse('optional', str(fd, p + 'label')));
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
  for (const k of PROFILE_FIELDS) {
    if (!fd.has(k)) continue;
    if (k === 'birthDate') {
      // A date input sends "1996-06-15" or nothing; an older birthYear in the file is kept, and the date wins.
      app[k] = str(fd, k).trim() || null;
      continue;
    }
    const v = fact(current[k], str(fd, k));
    app[k] = k === 'countryCode' && typeof v === 'string' ? v.toUpperCase() : v;
  }
  for (const k of APPLICANT_FACTS) app[k] = fact(current[k], str(fd, k));
  if (LETTER_FIELDS.some((k) => fd.has(`coverLetter.${k}`))) {
    const letter: Json = isObj(app.coverLetter) ? app.coverLetter : {};
    for (const k of LETTER_FIELDS) {
      const v = str(fd, `coverLetter.${k}`).trim();
      // A pitch must be text, so an empty one is removed; the other sentences become null (left out).
      set(letter, k, v || (k.startsWith('pitch.') ? undefined : null));
    }
    app.coverLetter = letter;
  }
  // One salary per country shown in the form; keys the form does not show are kept.
  const salary = isObj(app.expectedSalary) ? app.expectedSalary : {};
  for (const name of fd.keys()) {
    const k = /^expectedSalary\.(.+)$/.exec(name)?.[1];
    if (k) salary[k] = fact(salary[k], str(fd, name));
  }
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
