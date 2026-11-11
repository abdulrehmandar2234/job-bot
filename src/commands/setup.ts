import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { blankApplicant, buildProfile, profileGaps, readMaster, type MasterContact } from '../profile.ts';
import { AI_BASE_URL_ENV, AI_KEY_ENV, API_PRESETS, PRESETS, type ApiPreset } from '../ai-presets.ts';
import { applyMarkets, applyStacks, loadMarkets, loadStacks, pick, PRESETS_DIR, type PresetKind } from '../presets.ts';
import { APPLICANT_FILE, CONFIG_FILE, masterFile, path, ROOT, UTC_OFFSET, validate, type SettingsError } from '../settings.ts';
import type { DbState } from '../db-check.ts';
import { UserError } from '../errors.ts';
import type { Flags } from './shared.ts';

// `npm run bot -- setup`: a question-and-answer wizard that fills in the profile (cv/applicant.json) and the target
// markets (config.json). Every question shows the current value as its default, so pressing Enter keeps it and
// nothing is overwritten unseen; "-" clears a value. Both files are validated before anything is written.
// It needs no database and never loads config.json through config.ts, so it also works on a broken config.

type Json = Record<string, unknown>;
export type SetupIO = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
/**
 * `env` / `webEnv`: the bot's .env and the dashboard's web/.env.local. When given and missing, the wizard offers to
 * write them with DATABASE_URL (`setup` passes both; tests pass temp paths or leave them out, which skips the step).
 */
export type SetupFiles = {
  config: string;
  applicant: string;
  master?: MasterContact;
  presets?: string;
  env?: string;
  webEnv?: string;
  envExample?: string;
  /** cv/master.json and the example CV: when the first is missing, the wizard offers to copy the second to it. */
  masterPath?: string;
  masterExample?: string;
  /** Checks and creates the database in DATABASE_URL (src/db-check.ts); left out, the step is skipped. */
  database?: { check: (url: string) => Promise<DbState>; create: (url: string) => Promise<void> };
};

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) => (v == null ? '' : String(v));
const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads answers line by line; works for a terminal and for a piped or injected stream (tests). */
function prompter({ input, output }: SetupIO) {
  const tty = Boolean((input as { isTTY?: boolean }).isTTY);
  const rl = createInterface({ input, output: tty ? output : undefined, terminal: tty });
  const lines = rl[Symbol.asyncIterator]();
  let ended = false;
  const say = (s: string) => output.write(`${s}\n`);

  /** One question. Enter keeps the default, "-" clears it. `check` returns an error message to ask again. */
  async function ask(label: string, def: string, check?: (v: string) => string | null): Promise<string> {
    for (;;) {
      output.write(`${label}${def ? ` [${def}]` : ''}: `);
      const next = ended ? { done: true, value: '' } : await lines.next();
      if (next.done) ended = true;
      if (!tty) output.write('\n');
      const raw = next.done ? '' : String(next.value).trim();
      const value = raw === '' ? def : raw === '-' ? '' : raw;
      const error = check?.(value) ?? null;
      if (!error) return value;
      say(`  ${error}`);
      if (ended) throw new UserError(`Setup stopped: the input ended without a valid answer for "${label}". Nothing was saved.`);
    }
  }
  const yes = async (label: string, def: boolean) => {
    const a = await ask(`${label} (y/n)`, def ? 'y' : 'n', (v) => (/^(y|yes|n|no)$/i.test(v) ? null : 'answer y or n'));
    return /^y/i.test(a);
  };
  return { ask, yes, say, close: () => rl.close() };
}

const checks = {
  email: (v: string) => (!v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'not an email address'),
  url: (v: string) => (!v || /^https?:\/\/\S+$/.test(v) ? null : 'must start with https://'),
  code: (v: string) => (/^[A-Za-z]{2}$/.test(v) ? null : 'two letters, e.g. PT (ISO 3166-1 alpha-2)'),
  optCode: (v: string) => (!v || /^[A-Za-z]{2}$/.test(v) ? null : 'two letters, e.g. PT (ISO 3166-1 alpha-2)'),
  utc: (v: string) => (!v || UTC_OFFSET.test(v) ? null : 'like GMT+5, GMT+0 or UTC-3:30'),
  codes: (v: string) =>
    list(v).length && list(v).every((c) => /^[A-Za-z]{2}$/.test(c)) ? null : 'comma-separated two-letter codes, e.g. NL, AE',
  regex: (v: string) => {
    try {
      new RegExp(v, 'i');
      return null;
    } catch {
      return 'not a valid regular expression';
    }
  },
};

/** Checks a comma-separated list of preset ids: null when every id is known (or the list is empty). */
const presetIds =
  <T extends { id: string }>(all: T[], kind: PresetKind) =>
  (v: string) => {
    try {
      pick(all, list(v), kind);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

/** The CV file name config.default.json ships with: the wizard proposes one from the user's name instead. */
export const SHIPPED_CV_FILE_NAME = 'resume.pdf';

function readJson(file: string): Json | null {
  if (!existsSync(file)) return null;
  const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
  return isObj(v) ? v : null;
}

function write(file: string, obj: Json) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  renameSync(tmp, file);
}

/** How to find the Claude CLI on this OS. On Windows, spawn needs claude.exe (the native installer), not an npm claude.cmd. */
export const claudePathHint = (platform: NodeJS.Platform = process.platform) =>
  platform === 'win32' ? '`where claude`; use the claude.exe of the native installer, not claude.cmd' : '`which claude`';
const CLAUDE_PATH_HINT = claudePathHint();

export const NEXT_STEPS = [
  'Next: put your CV in cv/master.json (see cv/master.example.json), then `npm run bot -- cv:default` and `npm run bot -- fetch`.',
  'Check the whole setup at any time: `npm run bot -- doctor`.',
  "PDFs (CV and letters) need Chrome's headless shell, once: `npx playwright-core install chromium-headless-shell`.",
  'Daily fetch: `npm run bot -- schedule:print` prints the scheduler setup for this computer (docs/install/<your OS>.md, step 12).',
];

/** The connection string the install guides use (docs/install, step 4). */
export const DEFAULT_DATABASE_URL = 'postgres://postgres@127.0.0.1:5432/job_bot';
const DATABASE_URL_RE = /^postgres(ql)?:\/\/\S+$/;

/**
 * The text of a new .env: .env.example (its settings are all empty or commented out, so no key is ever written) and
 * the DATABASE_URL line. The dashboard's web/.env.local only needs the DATABASE_URL line.
 */
export function envText(databaseUrl: string, example: string | null = null): string {
  const head = example ? `${example.trimEnd()}\n\n` : '';
  return `${head}# The PostgreSQL database the bot uses.\nDATABASE_URL=${databaseUrl}\n`;
}

/** Writes `file` only when it does not exist yet (flag wx: never overwrites one, even one made meanwhile). */
function writeNew(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: 'wx' });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Offers to write the missing .env files with DATABASE_URL (the install guides' step 4), asking first. An existing
 * file is never touched, and no API key is ever asked for or written.
 */
async function offerEnvFiles(p: ReturnType<typeof prompter>, files: SetupFiles): Promise<string | undefined> {
  const missing = [files.env, files.webEnv].filter((f): f is string => !!f && !existsSync(f));
  if (!missing.length) return;
  p.say(
    `== Database connection ==\nNot found: ${missing.join(', ')}. ${missing.length > 1 ? 'They hold' : 'It holds'} DATABASE_URL, which the bot and the dashboard need.`,
  );
  if (!(await p.yes(`Write ${missing.length > 1 ? 'them' : 'it'} now (DATABASE_URL only, no keys)?`, true))) {
    p.say('Not written. Create them as your install guide shows (step 4).\n');
    return;
  }
  const url = await p.ask('DATABASE_URL', DEFAULT_DATABASE_URL, (v) =>
    DATABASE_URL_RE.test(v) ? null : 'like postgres://<user>:<password>@127.0.0.1:5432/job_bot',
  );
  const example = files.envExample && existsSync(files.envExample) ? readFileSync(files.envExample, 'utf8') : null;
  for (const file of missing) {
    const written = writeNew(file, envText(url, file === files.env ? example : null));
    p.say(written ? `Wrote ${file}.` : `${file} exists now; left as it is.`);
  }
  if (files.env && missing.includes(files.env)) p.say('Optional keys (Adzuna, an AI API key) go in .env later; see .env.example.');
  p.say('');
  return url;
}

/** Offers to create the database DATABASE_URL names when the server answers but the database does not exist. */
async function offerDatabase(p: ReturnType<typeof prompter>, files: SetupFiles, url: string | undefined) {
  if (!files.database || !url) return;
  const db = await files.database.check(url);
  if (db.state === 'ok') return;
  if (db.state === 'error') {
    p.say(`Could not reach the database (${db.message}). Fix that, then check with \`npm run bot -- doctor\`.\n`);
    return;
  }
  if (!(await p.yes(`The database "${db.name}" does not exist yet. Create it now?`, true))) {
    p.say(`Not created. Create it as your install guide shows (step 2), e.g. createdb -h 127.0.0.1 -U postgres ${db.name}\n`);
    return;
  }
  try {
    await files.database.create(url);
    p.say(`Created the database "${db.name}". Its tables are made by the first command that uses it.\n`);
  } catch (e) {
    p.say(`Could not create it: ${(e as Error).message}. Create it as your install guide shows (step 2).\n`);
  }
}

/** Offers to start cv/master.json from the example CV when it is missing (a fresh clone has none). */
async function offerMasterCv(p: ReturnType<typeof prompter>, files: SetupFiles) {
  if (!files.masterPath || !files.masterExample || existsSync(files.masterPath) || !existsSync(files.masterExample)) return;
  p.say(`== Your CV ==\n${files.masterPath} is missing. It is your CV as data; every PDF, letter and AI prompt is built from it.`);
  if (!(await p.yes('Start it from the example CV (Jane Doe), to replace with your own?', true))) {
    p.say('Not created. Write it yourself (see cv/master.example.json) before building CVs.\n');
    return;
  }
  copyFileSync(files.masterExample, files.masterPath);
  p.say(`Wrote ${files.masterPath}. Replace Jane Doe with yourself before you build CVs or apply (docs/your-cv-and-profile.md).\n`);
}

/** Runs the wizard. Returns true when the files were written. */
export async function runSetup(io: SetupIO, files: SetupFiles = { config: CONFIG_FILE, applicant: APPLICANT_FILE }): Promise<boolean> {
  const p = prompter(io);
  try {
    const cfg = readJson(files.config);
    if (!cfg) {
      p.say(`${files.config} is missing or not a JSON object. Start again from the shipped settings: copy config.default.json to it.`);
      return false;
    }
    p.say('Talaash setup. Press Enter to keep the value in [brackets], type "-" to clear it.\n');
    const url = (await offerEnvFiles(p, files)) ?? process.env.DATABASE_URL;
    await offerDatabase(p, files, url);
    await offerMasterCv(p, files);
    const app: Json = readJson(files.applicant) ?? (blankApplicant() as Json);
    const master = files.master ?? readMaster();
    const cur = buildProfile(app, master);

    p.say('== Your profile (cv/applicant.json) ==');
    app.fullName = (await p.ask('Full name', text(app.fullName) || text(cur.fullName))) || null;
    app.email = (await p.ask('Email', text(app.email) || text(cur.email), checks.email)) || null;
    app.phone = (await p.ask('Phone', text(app.phone) || text(cur.phone))) || null;
    app.linkedin = (await p.ask('LinkedIn URL', text(app.linkedin) || text(cur.linkedin), checks.url)) || null;
    app.city = (await p.ask('City you live in', text(app.city))) || null;
    app.country = (await p.ask('Country you live in', text(app.country))) || null;
    const code = (await p.ask('Its two-letter country code (ISO), e.g. PT', text(app.countryCode), checks.code)).toUpperCase();
    app.countryCode = code;
    app.utcOffset = (await p.ask('Your UTC offset, e.g. GMT+1', text(app.utcOffset), checks.utc)) || null;
    if (app.city && app.country && !text(app.currentLocation)) app.currentLocation = `${app.city}, ${app.country}`;
    app.languages = (await p.ask('Languages you speak, comma-separated', text(app.languages))) || null;
    app.workAuthorization = (await p.ask('Work authorisation (citizenship, permits)', text(app.workAuthorization))) || null;
    app.needsVisaSponsorship = (await p.ask('Visa sponsorship, in your words', text(app.needsVisaSponsorship))) || null;
    app.willingToRelocate = (await p.ask('Willing to relocate? (e.g. "Yes", "No")', text(app.willingToRelocate))) || null;

    p.say('\n== Where you are looking (config.json) ==');
    const markets = loadMarkets(files.presets ?? PRESETS_DIR);
    if (markets.length) {
      p.say('Market presets set the countries, LinkedIn locations and company boards (the list of companies is replaced):');
      for (const m of markets) p.say(`  ${m.id}: ${m.description}`);
      const ids = list(
        await p.ask('Start from market presets, comma-separated (Enter keeps config.json as it is)', '', presetIds(markets, 'markets')),
      );
      if (ids.length) Object.assign(cfg, applyMarkets(cfg, pick(markets, ids, 'markets')));
    }
    const countries = (isObj(cfg.countries) ? cfg.countries : {}) as Record<string, Json>;
    const codes = list(
      (
        await p.ask('Target countries for onsite jobs, two-letter codes, comma-separated', Object.keys(countries).join(', '), checks.codes)
      ).toUpperCase(),
    );
    const next: Record<string, Json> = {};
    for (const c of codes) {
      const known = countries[c] ?? {};
      const name = await p.ask(`  ${c}: country name`, text(known.name), (v) => (v ? null : 'required'));
      const match = await p.ask(
        `  ${c}: location pattern (regular expression)`,
        text(known.match) || esc(name.toLowerCase()),
        (v) => checks.regex(v) ?? (v ? null : 'required'),
      );
      const visa = await p.ask(
        `  ${c}: visa route (employer, or ind-register for the Netherlands)`,
        text(known.visa) || (c === 'NL' ? 'ind-register' : 'employer'),
        (v) => (v === 'employer' || v === 'ind-register' ? null : 'employer or ind-register'),
      );
      const needs = await p.yes(`  ${c}: do you need a work visa there?`, c === code ? false : known.needsVisa !== false);
      next[c] = { ...known, name, visa, match, needsVisa: needs };
    }
    cfg.countries = next;

    const remote = (isObj(cfg.remote) ? cfg.remote : {}) as Json;
    const linkedin = (isObj(cfg.linkedin) ? cfg.linkedin : {}) as Json;
    remote.enabled = await p.yes('Also look for remote jobs?', remote.enabled !== false);
    if (remote.enabled) {
      // A cloned config.json still names its previous owner's country: propose the one just entered, and show the old one.
      const was = text(remote.from) || text(linkedin.remoteFrom);
      const home = text(app.country);
      const moved = !!home && !!was && was.toLowerCase() !== home.toLowerCase();
      const from = await p.ask(
        `Remote work from which country${moved ? ` (config.json had ${was})` : ''}`,
        moved ? home : was || home,
        (v) => (v ? null : 'required'),
      );
      remote.from = from;
      const wasCode = text(remote.fromCode);
      const codeDefault = from.toLowerCase() === home.toLowerCase() ? code : wasCode || code;
      const codeLabel = wasCode && wasCode !== codeDefault ? ` (config.json had ${wasCode})` : '';
      remote.fromCode = (await p.ask(`Its two-letter code${codeLabel}`, codeDefault, checks.code)).toUpperCase();
      // The region patterns are computed from the country (src/regions.ts). Hand-written ones are offered again only
      // while the country stays the same: a cloned config.json's patterns belong to its previous owner's country.
      const sameCountry = was.toLowerCase() === from.toLowerCase() && (!wasCode || wasCode === remote.fromCode);
      if (!sameCountry) delete remote.flag;
      for (const [key, question] of [
        ['allow', 'Remote regions that include you'],
        ['deny', 'Remote regions that exclude you'],
      ] as const) {
        const custom = await p.ask(
          `${question} (regular expression; Enter = automatic for ${remote.fromCode})`,
          sameCountry ? text(remote[key]) : '',
          (v) => (v ? checks.regex(v) : null),
        );
        if (custom) remote[key] = custom;
        else delete remote[key];
      }
      linkedin.remoteFrom = from;
    }
    const names = Object.values(next).map((c) => text(c.name));
    const locations = Array.isArray(linkedin.locations) && linkedin.locations.length ? linkedin.locations.join(', ') : names.join(', ');
    linkedin.locations = list(await p.ask('LinkedIn onsite search locations, comma-separated', locations));
    cfg.remote = remote;
    cfg.linkedin = linkedin;
    const stacks = loadStacks(files.presets ?? PRESETS_DIR);
    if (stacks.length) {
      p.say('Stack presets set the search keywords and which job titles are kept:');
      for (const s of stacks) p.say(`  ${s.id}: ${s.description}`);
      const ids = list(
        await p.ask('Start from stack presets, comma-separated (Enter keeps config.json as it is)', '', presetIds(stacks, 'stacks')),
      );
      if (ids.length) Object.assign(cfg, applyStacks(cfg, pick(stacks, ids, 'stacks')));
    }

    const ai = (isObj(cfg.ai) ? cfg.ai : {}) as Json;
    p.say('AI for scoring, letters and answers: claude-cli (your signed-in Claude Code CLI, no API key) or api');
    p.say('(one API key in .env: OpenAI, Anthropic, Gemini, Groq, DeepSeek, ...; paid per token).');
    const wasApi = !!ai.provider && ai.provider !== 'claude-cli'; // "openai" / "deepseek" are older names for "api"
    const mode = (
      await p.ask('Claude CLI or API key (claude-cli / api)', wasApi ? 'api' : text(ai.provider) || 'claude-cli', (v) =>
        /^(claude-cli|api)$/i.test(v) ? null : 'claude-cli or api',
      )
    ).toLowerCase();
    if (mode === 'claude-cli') {
      // Missing means claude-cli, so the default is only written when the file already named a provider.
      if (ai.provider !== undefined) ai.provider = 'claude-cli';
      ai.claudePath = await p.ask(`Path to the Claude Code CLI (${CLAUDE_PATH_HINT})`, text(ai.claudePath), (v) => (v ? null : 'required'));
    } else {
      const legacy = ai.provider === 'openai' || ai.provider === 'deepseek' ? (ai.provider as 'openai' | 'deepseek') : null;
      const api = (isObj(ai.api) ? ai.api : {}) as Json;
      if (legacy) {
        // Move the older section's models into ai.api (its baseUrl had another form, so it is left to the user).
        const old = (isObj(ai[legacy]) ? ai[legacy] : {}) as Json;
        for (const k of ['scoreModel', 'letterModel']) if (old[k] && !api[k]) api[k] = old[k];
        delete ai[legacy];
      }
      ai.provider = 'api';
      ai.claudePath = text(ai.claudePath) || 'claude'; // still required by config.json, used if you switch back
      const choices = ['auto', ...API_PRESETS];
      const preset = (
        await p.ask(`Which provider (${choices.join(', ')}; auto = from the key)`, text(api.preset) || legacy || 'auto', (v) =>
          choices.includes(v.toLowerCase()) ? null : choices.join(', '),
        )
      ).toLowerCase() as ApiPreset | 'auto';
      if (preset === 'auto') delete api.preset;
      else api.preset = preset;
      if (preset === 'custom') {
        const base = await p.ask(`Its OpenAI-compatible base URL (empty = ${AI_BASE_URL_ENV} in .env)`, text(api.baseUrl), (v) =>
          !v || /^https?:\/\/\S+$/.test(v) ? null : 'must start with https://',
        );
        if (base) api.baseUrl = base;
        else delete api.baseUrl;
        api.scoreModel = await p.ask('Model for scoring', text(api.scoreModel), (v) => (v ? null : 'required'));
        api.letterModel = await p.ask('Model for writing', text(api.letterModel), (v) => (v ? null : 'required'));
      }
      if (Object.keys(api).length) ai.api = api;
      else delete ai.api;
      if (preset === 'ollama') {
        p.say(`Ollama needs no key; it must be running at ${PRESETS.ollama.baseUrl}.`);
      } else {
        p.say(`Put your API key in .env (in the Talaash folder) as ${AI_KEY_ENV}=...`);
        p.say('The wizard never asks for the key or saves it, and it never goes into config.json.');
      }
      if (preset === 'auto') {
        p.say('The provider is told from the key: sk-ant- Anthropic, gsk_ Groq, sk-or- OpenRouter, AIza Gemini, other sk- OpenAI.');
        p.say('DeepSeek keys also start with sk-: for DeepSeek, choose deepseek here.');
      } else if (preset !== 'custom') {
        const d = PRESETS[preset];
        const score = text(api.scoreModel) || d.scoreModel;
        const letter = text(api.letterModel) || d.letterModel;
        p.say(
          `${d.name} models: ${score} for scoring and ${letter} for writing; change them on the Settings page or in config.json ai.api.`,
        );
      }
    }
    cfg.ai = ai;
    const slug = text(app.fullName)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    cfg.cvFileName = await p.ask(
      'File name of your CV PDF',
      cfg.cvFileName && cfg.cvFileName !== SHIPPED_CV_FILE_NAME ? text(cfg.cvFileName) : `${slug || 'my'}_resume.pdf`,
      (v) => (/^[\w.-]+\.pdf$/.test(v) ? null : 'a file name ending in .pdf'),
    );

    const errors: SettingsError[] = [];
    for (const [kind, obj] of [
      ['applicant', app],
      ['config', cfg],
    ] as const) {
      const res = validate(kind, obj);
      if (!res.ok) errors.push(...res.errors.map((e) => ({ path: `${kind}: ${e.path}`, message: e.message })));
    }
    if (errors.length) {
      p.say('\nNot saved, these values are invalid:');
      for (const e of errors) p.say(`  - ${e.path}: ${e.message}`);
      return false;
    }
    if (!(await p.yes(`\nSave ${files.applicant} and ${files.config}?`, true))) {
      p.say('Nothing saved.');
      return false;
    }
    write(files.applicant, app);
    write(files.config, cfg);
    p.say('Saved.');
    const gaps = profileGaps(buildProfile(app, master));
    if (gaps.length)
      p.say(`Still missing in your profile: ${gaps.join(', ')}. Run setup again or edit it on the dashboard's Settings page.`);
    for (const line of NEXT_STEPS) p.say(line);
    return true;
  } finally {
    p.close();
  }
}

/** setup: the wizard on stdin/stdout. */
export async function setup(_args: string[], _flags: Flags) {
  const files: SetupFiles = {
    config: CONFIG_FILE,
    applicant: APPLICANT_FILE,
    // JOB_BOT_ENV_FILE is also what the dashboard's Settings page reads (web/lib/settings.ts botEnvFile).
    env: process.env.JOB_BOT_ENV_FILE || path('.env'),
    webEnv: process.env.JOB_BOT_WEB_ENV_FILE || join(ROOT, 'web', '.env.local'),
    envExample: path('.env.example'),
    masterPath: masterFile(),
    masterExample: path('cv', 'master.example.json'),
    database: await import('../db-check.ts').then((m) => ({ check: m.checkDatabase, create: m.createDatabase })),
  };
  if (!(await runSetup({ input: process.stdin, output: process.stdout }, files))) process.exitCode = 1;
}
