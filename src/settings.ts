import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Schemas for the two hand-edited settings files, config.json and cv/applicant.json. Loading them (config.ts, ai.ts)
// validates first, so a typo fails at startup with the file and field instead of deep inside a fetch.
// This module loads nothing itself, so `settings:check` still works while config.json is broken.

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const path = (...p: string[]) => join(ROOT, ...p);

// JOB_BOT_CONFIG / JOB_BOT_APPLICANT point the bot at other files (tests use temp copies).
export const CONFIG_FILE = process.env.JOB_BOT_CONFIG || path('config.json');
export const APPLICANT_FILE = process.env.JOB_BOT_APPLICANT || path('cv', 'applicant.json');
export const APPLICANT_EXAMPLE_FILE = path('cv', 'applicant.example.json');

// workday: token is "<tenant>/<wdN>/<site>", e.g. "acme/wd3/AcmeCareers".
export const ATS = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday'] as const;

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

const companySchema = z.object({
  name: text,
  ats: z.enum(ATS),
  token: text,
  indName: text.optional(), // legal name on the Dutch IND sponsor register, when it differs
});

export const configSchema = z.object({
  cvFileName: text,
  autoCvVersions: z.boolean(), // false = always send the default CV unless `prepare --cv <cluster>` is given
  chromePath: text,
  minScore: z.number(),
  maxAgeDays: count, // postings older than this are filtered out
  countries: z.record(z.string(), countrySchema),
  companies: z.array(companySchema),
  roleInclude: regex,
  roleExclude: regex,
  ai: z.object({
    enabled: z.boolean(),
    claudePath: text, // local Claude Code CLI (uses its signed-in account, no API key)
    scoreModel: text, // fast model for match scoring
    letterModel: text, // better writer for cover letters
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
    boards: z.array(text), // himalayas | remotive | remoteok | arbeitnow | adzuna
    himalayasQueries: z.array(text),
    allow: regex, // remote regions that include the candidate's country
    deny: regex, // remote regions / phrases that exclude it
    flag: regex, // allowed, but worth double-checking
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
export type Applicant = z.infer<typeof applicantSchema>;

export type SettingsKind = 'config' | 'applicant';
export type SettingsError = { path: string; message: string };
export type Validation<T> = { ok: true; value: T } | { ok: false; errors: SettingsError[] };

const SCHEMAS = { config: configSchema, applicant: applicantSchema };

/** companies[3].ats style path for an issue. */
const issuePath = (p: PropertyKey[]) =>
  p.map((k, i) => (typeof k === 'number' ? `[${k}]` : `${i ? '.' : ''}${String(k)}`)).join('') || '(root)';

/** Checks a parsed settings object. The value returned is the input itself (unknown keys kept). */
export function validate<K extends SettingsKind>(kind: K, obj: unknown): Validation<K extends 'config' ? Config : Applicant> {
  const res = SCHEMAS[kind].safeParse(obj);
  if (res.success) return { ok: true, value: obj as K extends 'config' ? Config : Applicant };
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
export class InvalidSettingsError extends Error {
  file: string;
  errors: SettingsError[];
  constructor(file: string, errors: SettingsError[]) {
    super(`Invalid settings file ${file}:\n${errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}`);
    this.name = 'InvalidSettingsError';
    this.file = file;
    this.errors = errors;
  }
}

/** Reads and validates a settings file, or throws InvalidSettingsError. */
export function loadSettings<K extends SettingsKind>(kind: K, file: string) {
  if (!existsSync(file)) throw new InvalidSettingsError(file, [{ path: '(root)', message: 'file not found' }]);
  const res = validateText(kind, readFileSync(file, 'utf8'));
  if (!res.ok) throw new InvalidSettingsError(file, res.errors);
  return res.value;
}
