import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROOT } from './bot';
import type { Json } from './settings-form';

// Reads config.json and cv/applicant.json for the settings page. Read-only: saving always goes through the
// bot's `settings:save` command, which is the single writer and validator (see app/settings/actions.ts).

// Same env overrides as the bot, read on every call so tests can point them at temp files.
export const configFile = () => process.env.JOB_BOT_CONFIG || join(BOT_ROOT, 'config.json');
export const applicantFile = () => process.env.JOB_BOT_APPLICANT || join(BOT_ROOT, 'cv', 'applicant.json');
export const applicantExampleFile = () => join(BOT_ROOT, 'cv', 'applicant.example.json');

export type SettingsFile = {
  file: string;          // the file that was read
  text: string;          // its raw content, for the JSON editor
  data: Json | null;     // parsed object, or null when the file is missing or not a JSON object
  error: string | null;  // why data is null
  example: boolean;      // applicant only: applicant.json is missing, so this is the example file
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
