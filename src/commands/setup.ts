import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { blankApplicant, buildProfile, profileGaps, readMaster, type MasterContact } from '../profile.ts';
import { AI_BASE_URL_ENV, AI_KEY_ENV, API_PRESETS, PRESETS, type ApiPreset } from '../ai-presets.ts';
import { APPLICANT_FILE, CONFIG_FILE, UTC_OFFSET, validate, type SettingsError } from '../settings.ts';
import type { Flags } from './shared.ts';

// `npm run bot -- setup`: a question-and-answer wizard that fills in the profile (cv/applicant.json) and the target
// markets (config.json). Every question shows the current value as its default, so pressing Enter keeps it and
// nothing is overwritten unseen; "-" clears a value. Both files are validated before anything is written.
// It needs no database and never loads config.json through config.ts, so it also works on a broken config.

type Json = Record<string, unknown>;
export type SetupIO = { input: NodeJS.ReadableStream; output: NodeJS.WritableStream };
export type SetupFiles = { config: string; applicant: string; master?: MasterContact };

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
      if (ended) throw new Error(`no valid answer for "${label}"`);
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

/** The remote "allow" pattern for a new remote-from country: worldwide-style regions plus the country itself. */
export function defaultAllow(current: string, country: string): string {
  const c = country.toLowerCase();
  if (!c || new RegExp(`\\b${esc(c)}\\b`, 'i').test(current)) return current;
  return `worldwide|anywhere|global|${esc(c)}|emea|international`;
}

/** The "deny" pattern without the remote-from country (a list of excluded regions must not exclude home). */
export function defaultDeny(current: string, country: string): string {
  const c = country.toLowerCase();
  if (!c) return current;
  return current
    .split('|')
    .filter((part) => !new RegExp(`^(\\\\b)?${esc(c)}(\\\\b)?$`, 'i').test(part))
    .join('|');
}

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

/** Runs the wizard. Returns true when the files were written. */
export async function runSetup(io: SetupIO, files: SetupFiles = { config: CONFIG_FILE, applicant: APPLICANT_FILE }): Promise<boolean> {
  const p = prompter(io);
  try {
    const cfg = readJson(files.config);
    if (!cfg) {
      p.say(`${files.config} is missing or not a JSON object. Restore it from git first (git checkout config.json).`);
      return false;
    }
    const app: Json = readJson(files.applicant) ?? (blankApplicant() as Json);
    const master = files.master ?? readMaster();
    const cur = buildProfile(app, master);

    p.say('job-bot setup. Press Enter to keep the value in [brackets], type "-" to clear it.\n');
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
      remote.allow = await p.ask(
        'Remote regions that include you (regular expression)',
        defaultAllow(text(remote.allow), from),
        checks.regex,
      );
      remote.deny = await p.ask('Remote regions that exclude you (regular expression)', defaultDeny(text(remote.deny), from), checks.regex);
      linkedin.remoteFrom = from;
    }
    const names = Object.values(next).map((c) => text(c.name));
    const locations = Array.isArray(linkedin.locations) && linkedin.locations.length ? linkedin.locations.join(', ') : names.join(', ');
    linkedin.locations = list(await p.ask('LinkedIn onsite search locations, comma-separated', locations));
    cfg.remote = remote;
    cfg.linkedin = linkedin;

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
      ai.claudePath = await p.ask('Path to the Claude Code CLI (`which claude`)', text(ai.claudePath), (v) => (v ? null : 'required'));
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
        p.say(`Put your API key in .env (in the job-bot folder) as ${AI_KEY_ENV}=...`);
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
    cfg.cvFileName = await p.ask('File name of your CV PDF', text(cfg.cvFileName) || `${slug || 'my'}_resume.pdf`, (v) =>
      /^[\w.-]+\.pdf$/.test(v) ? null : 'a file name ending in .pdf',
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
    p.say('Next: put your CV in cv/master.json (see cv/master.example.json), then `npm run bot -- cv:default` and `npm run bot -- fetch`.');
    return true;
  } finally {
    p.close();
  }
}

/** setup: the wizard on stdin/stdout. */
export async function setup(_args: string[], _flags: Flags) {
  if (!(await runSetup({ input: process.stdin, output: process.stdout }))) process.exitCode = 1;
}
