import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as bot from '../../src/settings.ts';
import { BOT_ROOT } from './bot';
import { AI_KEY_ENV, detectPreset, LEGACY_KEY_ENV, type ApiPreset, type Json } from './settings-form';

// Reads config.json and cv/applicant.json for the settings page. Read-only: saving always goes through the
// bot's `settings:save` command, which is the single writer and validator (see app/settings/actions.ts).

// The bot's file helpers, rooted at BOT_ROOT (web/..): the same JOB_BOT_CONFIG / JOB_BOT_APPLICANT / JOB_BOT_MASTER
// overrides, read on every call so tests can point them at temp files. Every dashboard read of these files goes
// through them.
export const configFile = () => bot.configFile(BOT_ROOT);
export const applicantFile = () => bot.applicantFile(BOT_ROOT);
export const masterFile = () => bot.masterFile(BOT_ROOT);
// The shipped settings: config.json is personal and gitignored, and starts as a copy of this file (as in the bot).
export const defaultConfigFile = () => join(BOT_ROOT, 'config.default.json');
export const applicantExampleFile = () => join(BOT_ROOT, 'cv', 'applicant.example.json');

/**
 * Creates config.json from config.default.json when it does not exist yet (a fresh clone): the bot's
 * ensureConfigFile, at BOT_ROOT. A missing JOB_BOT_CONFIG file stays missing. Returns true when it copied.
 */
export const ensureConfigFile = (file = configFile(), defaults = defaultConfigFile(), home = join(BOT_ROOT, 'config.json')) =>
  bot.ensureConfigFile(file, defaults, home);
// The bot's own env file (talaash/.env, loaded by `npm run bot` and by the bot runs the dashboard starts).
export const botEnvFile = () => process.env.JOB_BOT_ENV_FILE || join(BOT_ROOT, '.env');

export type SettingsFile = {
  file: string; // the file that was read
  text: string; // its raw content, for the JSON editor
  data: Json | null; // parsed object, or null when the file is missing or not a JSON object
  error: string | null; // why data is null
  example: boolean; // applicant only: applicant.json is missing, so this is the example file
};

function read(file: string, example = false): SettingsFile {
  if (!existsSync(file)) return { file, text: '', data: null, error: 'file not found', example };
  const text = readFileSync(file, 'utf8');
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { file, text, data: null, error: 'not a JSON object', example };
    return { file, text, data: data as Json, error: null, example };
  } catch (e) {
    return { file, text, data: null, error: `invalid JSON: ${(e as Error).message}`, example };
  }
}

export const readConfig = () => read(configFile());

/**
 * config.json `ai.enabled`, read on every call. Only an explicit `false` turns the AI-only buttons off: a missing or
 * broken config.json leaves them on, and the bot then reports the real problem.
 */
export function aiEnabled(): boolean {
  const ai = readConfig().data?.ai;
  return !(ai && typeof ai === 'object' && !Array.isArray(ai) && (ai as Record<string, unknown>).enabled === false);
}

/** cv/applicant.json, or the example file while the user has not created one. */
export function readApplicant(): SettingsFile {
  const file = applicantFile();
  return existsSync(file) ? read(file) : read(applicantExampleFile(), true);
}

/**
 * Whether the bot will find an AI API key, and whose key it looks like. Only the variable name and the provider
 * detected from the key's prefix leave this function: never the value.
 */
export type AiKeyStatus = { keyEnv: string | null; provider: ApiPreset | null };

/**
 * The bot reads AI_API_KEY (or the older OPENAI_API_KEY / DEEPSEEK_API_KEY) from talaash/.env, and also inherits the
 * environment of whoever starts it (the bot runs the dashboard starts get the dashboard's). The environment wins.
 */
export function aiKeyStatus(): AiKeyStatus {
  const values = new Map<string, string>();
  const file = botEnvFile();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [, name, raw] = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line) ?? [];
      const value = raw
        ?.replace(/\s+#.*$/, '')
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim();
      if (name && value) values.set(name, value);
    }
  }
  const read = (name: string) => process.env[name]?.trim() || values.get(name) || '';
  const key = read(AI_KEY_ENV);
  if (key) return { keyEnv: AI_KEY_ENV, provider: detectPreset(key) };
  for (const [preset, name] of Object.entries(LEGACY_KEY_ENV) as [ApiPreset, string][]) {
    if (read(name)) return { keyEnv: name, provider: preset };
  }
  return { keyEnv: null, provider: null };
}
