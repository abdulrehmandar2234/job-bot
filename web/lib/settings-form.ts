// Pure helpers for the settings forms, safe to import from client components (no node: modules).
// Type-only imports from the bot: erased at build time, so no bot code is bundled into the dashboard.
import type { Company, SettingsError, SettingsKind } from '../../src/settings';

export type { SettingsError, SettingsKind };
export type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

// ---- AI presets: a copy of src/ai-presets.ts (web/tests/lib/settings.test.ts checks they match) ----

export const RESPONSE_FORMATS = ['json_schema', 'json_object', 'text'] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export const API_PRESETS = [
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'groq',
  'openrouter',
  'mistral',
  'together',
  'ollama',
  'custom',
] as const;
export type ApiPreset = (typeof API_PRESETS)[number];

export type Preset = {
  name: string;
  /** OpenAI-compatible base URL; requests go to `${baseUrl}/chat/completions`. Empty for custom. */
  baseUrl: string;
  scoreModel: string;
  letterModel: string;
  format: ResponseFormat;
  /** False when the API needs no key (a local Ollama). */
  needsKey: boolean;
  /** False when the API rejects `temperature` (Anthropic's current models). */
  temperature: boolean;
};

// Defaults only: every model can be changed in config.json ai.api or on the dashboard's Settings page.
export const PRESETS: Record<ApiPreset, Preset> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    scoreModel: 'gpt-4o-mini',
    letterModel: 'gpt-4o',
    format: 'json_schema',
    needsKey: true,
    temperature: true,
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    scoreModel: 'deepseek-chat',
    letterModel: 'deepseek-chat',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  // OpenAI SDK compatibility layer: response_format is ignored there, and current models reject temperature.
  anthropic: {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    scoreModel: 'claude-haiku-5-5',
    letterModel: 'claude-sonnet-5-5',
    format: 'text',
    needsKey: true,
    temperature: false,
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    scoreModel: 'gemini-2.5-flash',
    letterModel: 'gemini-2.5-pro',
    format: 'json_schema',
    needsKey: true,
    temperature: true,
  },
  groq: {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    scoreModel: 'llama-3.1-8b-instant',
    letterModel: 'llama-3.3-70b-versatile',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  // Many models behind one key: JSON mode with the schema in the prompt works for most of them.
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    scoreModel: 'openai/gpt-4o-mini',
    letterModel: 'openai/gpt-4o',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  mistral: {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    scoreModel: 'mistral-small-latest',
    letterModel: 'mistral-large-latest',
    format: 'json_schema',
    needsKey: true,
    temperature: true,
  },
  together: {
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    scoreModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    letterModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    format: 'json_object',
    needsKey: true,
    temperature: true,
  },
  ollama: {
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    scoreModel: 'llama3.1',
    letterModel: 'llama3.1',
    format: 'json_object',
    needsKey: false,
    temperature: true,
  },
  // Any other OpenAI-compatible endpoint: base URL from AI_BASE_URL or ai.api.baseUrl, models from ai.api.
  custom: {
    name: 'Custom endpoint',
    baseUrl: '',
    scoreModel: '',
    letterModel: '',
    format: 'json_object',
    needsKey: false,
    temperature: true,
  },
};

/**
 * The provider a key belongs to, from its prefix, or null when it cannot be told. DeepSeek keys also start with
 * "sk-", so they look like OpenAI keys: DeepSeek needs ai.api.preset "deepseek" (or AI_BASE_URL).
 */
export function detectPreset(key: string | undefined | null): ApiPreset | null {
  const k = key?.trim() ?? '';
  if (k.startsWith('sk-ant-')) return 'anthropic';
  if (k.startsWith('sk-or-')) return 'openrouter';
  if (k.startsWith('gsk_')) return 'groq';
  if (k.startsWith('AIza')) return 'gemini';
  if (k.startsWith('sk-')) return 'openai';
  return null;
}

export const AI_KEY_ENV = 'AI_API_KEY';
/** Older per-provider key variables, still read by the bot as fallbacks for AI_API_KEY. */
export const LEGACY_KEY_ENV = { openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY' } as const;
/** The provider select: "openai" / "deepseek" in config.json are older names for "api". */
export const isApiProvider = (v: unknown) => v === 'api' || v === 'openai' || v === 'deepseek';

/** Same list as the bot's ATS (src/settings.ts); tests/lib/settings.test.ts checks they match. */
export const ATS: readonly Company['ats'][] = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday'];

// Form field names are the same paths the validator reports (`ai.enabled`, `companies[3].ats`), so errors map
// straight onto fields. Merging starts from the current file, so keys the form does not show are kept.

// optional: an empty field removes the key; code: optional, upper-cased (ISO country code).
type FieldType = 'number' | 'bool' | 'text' | 'lines' | 'optional' | 'code';

export const CONFIG_FIELDS: Record<string, FieldType> = {
  minScore: 'number',
  maxAgeDays: 'number',
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
