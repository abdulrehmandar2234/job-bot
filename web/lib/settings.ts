import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROOT } from './bot';
import { API_PROVIDERS, KEY_ENV, type ApiProvider, type Json } from './settings-form';

// Reads config.json and cv/applicant.json for the settings page. Read-only: saving always goes through the
// bot's `settings:save` command, which is the single writer and validator (see app/settings/actions.ts).

// Same env overrides as the bot, read on every call so tests can point them at temp files.
export const configFile = () => process.env.JOB_BOT_CONFIG || join(BOT_ROOT, 'config.json');
export const applicantFile = () => process.env.JOB_BOT_APPLICANT || join(BOT_ROOT, 'cv', 'applicant.json');
export const applicantExampleFile = () => join(BOT_ROOT, 'cv', 'applicant.example.json');
// The bot's own env file (job-bot/.env, loaded by `npm run bot` and by the bot runs the dashboard starts).
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

/** cv/applicant.json, or the example file while the user has not created one. */
export function readApplicant(): SettingsFile {
  const file = applicantFile();
  return existsSync(file) ? read(file) : read(applicantExampleFile(), true);
}

/** Whether each API provider's key is set, as the bot will see it. Only names are checked; values never leave here. */
export type AiKeyStatus = Record<ApiProvider, boolean>;

/**
 * The bot reads its API keys from job-bot/.env, and also inherits the environment of whoever starts it (the bot
 * runs the dashboard starts get the dashboard's). A key counts as set when either has a non-empty value.
 */
export function aiKeyStatus(): AiKeyStatus {
  const names = new Set<string>();
  const file = botEnvFile();
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [, name, raw] = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line) ?? [];
      const value = raw
        ?.replace(/\s+#.*$/, '')
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim();
      if (name && value) names.add(name);
    }
  }
  const status = {} as AiKeyStatus;
  for (const p of API_PROVIDERS) status[p] = names.has(KEY_ENV[p]) || !!process.env[KEY_ENV[p]]?.trim();
  return status;
}
