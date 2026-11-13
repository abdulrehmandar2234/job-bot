import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { API_PRESETS, RESPONSE_FORMATS } from './ai-presets.ts';
import { TEMPLATE_IDS } from './cv/templates/index.ts';
import { UserError } from './errors.ts';
import { ATS, JOB_TYPES, REMOTE_BOARDS } from './types.ts';

// Schemas for the two hand-edited settings files, config.json and cv/applicant.json. Loading them (config.ts, ai.ts)
// validates first, so a typo fails at startup with the file and field instead of deep inside a fetch.
// This module loads nothing itself, so `settings:check` still works while config.json is broken.

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const path = (...p: string[]) => join(ROOT, ...p);

// JOB_BOT_CONFIG / JOB_BOT_APPLICANT / JOB_BOT_MASTER point the bot at other files (tests use temp copies). The
// functions read the environment on every call; every read or write of these files goes through them. `root` is the
// bot's folder: this one, or where the dashboard finds it (web/lib/settings.ts passes its BOT_ROOT, which its tests
// move). CONFIG_FILE and APPLICANT_FILE are their values at startup.
export const configFile = (root = ROOT) => process.env.JOB_BOT_CONFIG || join(root, 'config.json');
export const applicantFile = (root = ROOT) => process.env.JOB_BOT_APPLICANT || join(root, 'cv', 'applicant.json');
export const masterFile = (root = ROOT) => process.env.JOB_BOT_MASTER || join(root, 'cv', 'master.json');
// JOB_BOT_DATA_DIR moves the bot's working folder (logs, temp files, caches, previews, backups of the master CV); by
// default it is <root>/data. Read on every call, so tests point it at a temp dir. Explicit per-file overrides
// (JOB_BOT_IND_FILE, JOB_BOT_BACKUP_DIR, JOB_BOT_HTTP_CACHE, JOB_BOT_CV_BACKUP_DIR) still win over it.
export const dataDir = (root = ROOT) => process.env.JOB_BOT_DATA_DIR || join(root, 'data');
export const dataPath = (...p: string[]) => join(dataDir(), ...p);
export const CONFIG_FILE = configFile();
// The shipped settings: config.json is personal and gitignored, and starts as a copy of this file.
export const DEFAULT_CONFIG_FILE = path('config.default.json');

/**
 * Creates config.json from config.default.json when it does not exist yet (a fresh clone). Only the default
 * location is filled in: a missing JOB_BOT_CONFIG file stays missing, so a typo in it is still reported.
 * Returns true when it copied.
 */
export function ensureConfigFile(file = configFile(), defaults = DEFAULT_CONFIG_FILE, home = path('config.json')): boolean {
  if (file !== home || existsSync(file) || !existsSync(defaults)) return false;
  copyFileSync(defaults, file);
  return true;
}
export const APPLICANT_FILE = applicantFile();
export const APPLICANT_EXAMPLE_FILE = path('cv', 'applicant.example.json');

// The ATS and remote board lists live in types.ts, which the dashboard's client components import too.
export { ATS, REMOTE_BOARDS };

const text = z.string().min(1);
const regex = z.string().refine((s) => {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');
const count = z.number().int().nonnegative();
const isoCode = z.string().regex(/^[A-Z]{2}$/, 'two capital letters (ISO 3166-1 alpha-2), e.g. "PT"');

const countrySchema = z.object({
  name: text,
  visa: z.enum(['employer', 'ind-register']), // who sorts out the work permit: the employer, or a Dutch IND-registered sponsor
  match: regex, // location text that means this country
  needsVisa: z.boolean().optional(), // false = the candidate may already work here (no sponsorship filters); missing = true
  label: text.optional(), // short name for the dashboard, e.g. "Saudi"; missing = name
});

// The API provider (`ai.provider: "api"`): any OpenAI-compatible chat API. The key is never here: it comes from the
// environment only (AI_API_KEY in .env), see src/ai-providers.ts. Everything is optional; missing = the preset's.
const apiSchema = z
  .object({
    preset: z.enum(API_PRESETS), // missing = detected from the key's prefix (or "custom" with a base URL)
    baseUrl: z.url(), // OpenAI-compatible base URL, e.g. "https://api.openai.com/v1"; AI_BASE_URL in .env wins
    scoreModel: text, // fast model for match scoring
    letterModel: text, // better writer for letters, answers, interview prep and follow-ups
    responseFormat: z.enum(RESPONSE_FORMATS), // how JSON is asked for; missing = the preset's
  })
  .partial();

// Before "api" existed, "openai" / "deepseek" were providers of their own with these sections. Still read, as "api"
// with that preset (baseUrl here was the host, without /v1 for OpenAI).
const legacyApiSchema = z.object({ scoreModel: text, letterModel: text, baseUrl: z.url() }).partial();

/** Who runs the AI features. "openai" and "deepseek" are older names for "api" with that preset. */
export const AI_PROVIDERS = ['claude-cli', 'api', 'openai', 'deepseek'] as const;

const companySchema = z.object({
  name: text,
  ats: z.enum(ATS),
  token: text,
  indName: text.optional(), // legal name on the Dutch IND sponsor register, when it differs
});

export const configSchema = z.object({
  cvFileName: text,
  autoCvVersions: z.boolean(), // false = always send the default CV unless `prepare --cv <cluster>` is given
  cvTemplate: z.enum(TEMPLATE_IDS).optional(), // CV design for jobs without one of their own (src/cv/templates); missing = classic
  chromePath: text.optional(), // "auto" or missing: Playwright's headless shell, else a system Chrome (src/cv/chrome.ts)
  minScore: z.number(),
  maxAgeDays: count, // postings older than this are filtered out
  // When the scheduled daily run starts, local time, 24-hour "HH:MM" (src/commands/daily.ts). Missing = 09:00.
  dailyTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'a 24-hour time like "09:00" or "18:30"')
    .optional(),
  // Job types to filter out when a source states them (src/match.ts jobTypeOf). Missing = DEFAULT_SKIP_JOB_TYPES.
  skipJobTypes: z.array(z.enum(JOB_TYPES)).optional(),
  // Companies never to show (src/match.ts): compared by companyKey, so "Acme Inc." also hides "ACME". Missing = none.
  blockedCompanies: z.array(text).optional(),
  countries: z.record(z.string(), countrySchema),
  companies: z.array(companySchema),
  // Stack presets (presets/stacks) whose skills and CV clusters drive the keyword score (src/match.ts).
  // Missing or empty = php-laravel + javascript, the stacks config.default.json is built from.
  stacks: z.array(text).optional(),
  roleInclude: regex,
  roleExclude: regex,
  ai: z.object({
    enabled: z.boolean(),
    provider: z.enum(AI_PROVIDERS).optional(), // who runs the AI features; missing = claude-cli
    claudePath: text, // local Claude Code CLI (uses its signed-in account, no API key)
    scoreModel: text, // Claude CLI: fast model for match scoring
    letterModel: text, // Claude CLI: better writer for cover letters
    api: apiSchema.optional(), // the API provider: preset, base URL, models
    openai: legacyApiSchema.optional(), // older provider "openai"
    deepseek: legacyApiSchema.optional(), // older provider "deepseek"
    maxScorePerRun: count, // cap per `ai:score` run
    concurrency: z.number().int().positive(),
    alertStrong: z.boolean().optional(), // macOS notification for each new `strong` verdict; missing = on
  }),
  linkedin: z.object({
    enabled: z.boolean(),
    keywords: z.array(text),
    locations: z.array(text), // onsite searches, as typed in LinkedIn's location box
    remoteFrom: z.string(), // remote (f_WT=2) search located here, e.g. "Portugal"; empty = no remote search
    pagesPerSearch: count, // 10 results per page
  }),
  remote: z.object({
    enabled: z.boolean(),
    boards: z.array(z.enum(REMOTE_BOARDS)), // a typo here used to disable a board silently; now it fails validation
    himalayasQueries: z.array(text),
    // Missing or empty = computed from the remote-from country (src/regions.ts); set = used as written.
    allow: regex.optional(), // remote regions that include the candidate's country
    deny: regex.optional(), // remote regions / phrases that exclude it
    flag: regex.optional(), // allowed, but worth double-checking
    // The country remote work is done from (where the candidate lives). Missing = linkedin.remoteFrom, then the
    // profile's country (cv/applicant.json) for `from`, and the profile's countryCode for `fromCode`.
    from: text.optional(), // e.g. "Portugal", used in filter reasons, the visa note and the AI prompts
    fromCode: isoCode.optional(), // ISO 3166-1 alpha-2, e.g. "PT": Himalayas only lists jobs open to this country
  }),
  // Optional, so older config.json files still load. Adzuna has no 'ae' or 'sa' index.
  adzuna: z
    .object({
      countries: z.array(text),
      keywords: z.array(text).optional(), // defaults to linkedin.keywords
      pagesPerSearch: count, // 50 results per page
    })
    .optional(),
});

// A fact for application forms; null = unknown, so the AI writes [FILL: ...] instead of guessing.
const fact = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const optText = z.union([z.string(), z.null()]);

// "GMT+5", "UTC-3:30", "GMT+0".
export const UTC_OFFSET = /^(GMT|UTC)[+-]\d{1,2}(:[0-5]\d)?$/;

/**
 * Sentences of the template cover letter (src/cover.ts, used when the AI is off or fails) that only the candidate can
 * write. Missing ones are left out. `pitch` is per CV cluster (see src/cv/profiles.ts), plus "default".
 */
const coverLetterSchema = z
  .object({
    intro: optText, // "I am a Senior Full Stack Engineer with 7+ years of experience ..."
    pitch: z.record(z.string(), z.string()),
    strengths: optText, // after "Your posting asks for X, which is the core of my day-to-day work."
    remote: optText, // after "I am based in <location> (<UTC offset>)," for remote roles
  })
  .partial();

export const applicantSchema = z
  .object({
    _help: z.string(),
    // The profile: who the candidate is. Name and contact default to cv/master.json when missing.
    fullName: optText,
    email: z.union([z.email(), z.literal(''), z.null()]),
    phone: optText,
    linkedin: z.union([z.url(), z.literal(''), z.null()]),
    city: optText,
    country: optText,
    countryCode: z.union([isoCode, z.null()]), // where the candidate lives, ISO 3166-1 alpha-2
    utcOffset: z.union([z.string().regex(UTC_OFFSET, 'like "GMT+5" or "UTC-3:30"'), z.null()]),
    // Only for the Dutch IND salary check (src/ind-salary.ts): the minimum depends on whether the candidate is 30 or over.
    // birthDate ("1996-06-15") gives the exact age; birthYear alone counts from 1 January.
    birthDate: z.union([
      z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like "1996-06-15"')
        .refine((d) => {
          const t = new Date(`${d}T00:00:00Z`);
          return !Number.isNaN(t.getTime()) && t.toISOString().startsWith(d) && d >= '1940' && d < '2016';
        }, 'a real date between 1940 and 2015'),
      z.null(),
    ]),
    birthYear: z.union([z.number().int().min(1940).max(2015), z.null()]),
    workAuthorization: fact, // free text, e.g. "Portuguese citizen, may work anywhere in the EU"
    coverLetter: coverLetterSchema,
    // Facts for application forms.
    currentLocation: fact,
    languages: fact,
    needsVisaSponsorship: fact,
    willingToRelocate: fact,
    nationality: fact,
    noticePeriod: fact,
    earliestStartDate: fact,
    currentSalary: fact,
    expectedSalary: z.record(z.string(), fact), // per country code, plus "remote"
    workingHoursForRemote: fact,
    howDidYouHear: fact,
    other: z.record(z.string(), fact),
  })
  .partial(); // a missing fact is unknown too; extra keys are passed to the AI as they are

export type Country = z.infer<typeof countrySchema>;
export type Company = z.infer<typeof companySchema>;
export type Config = z.infer<typeof configSchema>;
export type AiSettings = Config['ai'];
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type Applicant = z.infer<typeof applicantSchema>;

export type SettingsKind = 'config' | 'applicant';
export type SettingsError = { path: string; message: string };
export type Validation<T> = { ok: true; value: T; warnings: SettingsError[] } | { ok: false; errors: SettingsError[] };

const SCHEMAS = { config: configSchema, applicant: applicantSchema };

/** companies[3].ats style path for an issue. */
const issuePath = (p: PropertyKey[]) =>
  p.map((k, i) => (typeof k === 'number' ? `[${k}]` : `${i ? '.' : ''}${String(k)}`)).join('') || '(root)';

const KNOWN_CONFIG_KEYS = new Set(Object.keys(configSchema.shape));

/**
 * Unknown top-level config keys are kept (forward compatibility) but worth a warning: a misspelled key ("minscore")
 * would otherwise be ignored silently while the real setting keeps its default. Applicant files are not checked:
 * extra keys there are facts passed to the AI on purpose.
 */
function configWarnings(kind: SettingsKind, obj: unknown): SettingsError[] {
  if (kind !== 'config' || !obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj)
    .filter((k) => !KNOWN_CONFIG_KEYS.has(k))
    .map((k) => ({
      path: k,
      message: 'unknown setting (Talaash does not read this key — if it is a misspelling, the real setting keeps its default)',
    }));
}

/** Checks a parsed settings object. The value returned is the input itself (unknown keys kept, with a warning). */
export function validate<K extends SettingsKind>(kind: K, obj: unknown): Validation<K extends 'config' ? Config : Applicant> {
  const res = SCHEMAS[kind].safeParse(obj);
  if (res.success) return { ok: true, value: obj as K extends 'config' ? Config : Applicant, warnings: configWarnings(kind, obj) };
  return { ok: false, errors: res.error.issues.map((i) => ({ path: issuePath(i.path), message: i.message })) };
}

export const validateConfig = (obj: unknown) => validate('config', obj);
export const validateApplicant = (obj: unknown) => validate('applicant', obj);

/** Parses JSON text and validates it; invalid JSON is reported like any other error. */
export function validateText<K extends SettingsKind>(kind: K, json: string): Validation<K extends 'config' ? Config : Applicant> {
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (e) {
    return { ok: false, errors: [{ path: '(root)', message: `invalid JSON: ${(e as Error).message}` }] };
  }
  return validate(kind, obj);
}

/** Thrown when a settings file is missing or invalid; its message names the file and every bad field. */
export class InvalidSettingsError extends UserError {
  file: string;
  errors: SettingsError[];
  constructor(file: string, errors: SettingsError[]) {
    super(`Invalid settings file ${file}:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'InvalidSettingsError';
    this.file = file;
    this.errors = errors;
  }
}

/**
 * Writes a settings object as pretty JSON: to a temp file next to the target, then renamed over it, so a crash never
 * leaves a half-written file.
 */
export function writeSettingsFile(file: string, obj: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Reads and validates a settings file, or throws InvalidSettingsError. Unknown top-level keys are warned about. */
export function loadSettings<K extends SettingsKind>(kind: K, file: string) {
  if (!existsSync(file)) throw new InvalidSettingsError(file, [{ path: '(root)', message: 'file not found' }]);
  const res = validateText(kind, readFileSync(file, 'utf8'));
  if (!res.ok) throw new InvalidSettingsError(file, res.errors);
  for (const w of res.warnings) console.warn(`Warning: ${file}: ${w.path}: ${w.message}`);
  return res.value;
}
