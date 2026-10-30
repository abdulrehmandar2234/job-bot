import { existsSync, readFileSync } from 'node:fs';
import { countryLabels, market, marketLine, profileGaps, type MasterContact, type ProfileField } from './market';
import { applicantFile, masterFile, readConfig } from './settings';

// Reads config.json, cv/applicant.json and cv/master.json on every call (they change outside the dashboard) for the
// header, the country labels and the first-run banner. Missing or broken files give empty values, never an error.

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The user's own applicant.json, or null when it does not exist yet (the example file is never a profile). */
const readApplicantData = () => (existsSync(applicantFile()) ? readJson(applicantFile()) : null);

export function readMarket() {
  return market(readConfig().data, readApplicantData());
}

/** "AE" -> "🇦🇪 UAE", "RM" -> "🌍 Remote (from ...)", from the current config.json. */
export const readCountryLabels = () => countryLabels(readMarket());
export const readMarketLine = () => marketLine(readMarket());

export type ProfileStatus = { exists: boolean; gaps: ProfileField[] };

/** Whether cv/applicant.json exists and which required profile fields are still empty. */
export function readProfileStatus(): ProfileStatus {
  const app = readApplicantData();
  const master = (readJson(masterFile()) ?? {}) as MasterContact;
  return { exists: existsSync(applicantFile()), gaps: profileGaps(app ?? {}, master) };
}
