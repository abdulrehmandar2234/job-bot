import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config, path, type Company } from './config.ts';
import { getText } from './sources/http.ts';

// Dutch IND public register of recognised sponsors (erkend referent) for highly skilled migrants.
// Only these employers can sponsor a Dutch highly-skilled-migrant visa.
const IND_URL = 'https://ind.nl/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants';
/** Where the register is saved; JOB_BOT_IND_FILE overrides it (tests). Read on every call. */
export const indFile = () => process.env.JOB_BOT_IND_FILE || path('data', 'ind-sponsors.json');
/** `bot daily` downloads the register again when it is older than this many days, or missing. */
export const IND_MAX_AGE_DAYS = 7;

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/["'.,()&@]/g, ' ')
    .replace(/\b(b ?v|n ?v|holding|holdings|netherlands|nederland|benelux|europe|international|group|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

let cache: Set<string> | null = null;

export async function updateIndRegister() {
  const html = await getText(IND_URL);
  const names = [...html.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1].replace(/""/g, '"').trim());
  if (names.length < 1000) throw new Error(`IND register looks wrong: only ${names.length} rows parsed`);
  writeFileSync(indFile(), JSON.stringify({ updated: new Date().toISOString(), names }, null, 0));
  cache = null; // a register read earlier in this process is out of date now
  return names.length;
}

/** When the saved register was downloaded; null when it is missing or unreadable. */
export function indUpdatedAt(file = indFile()): Date | null {
  try {
    const updated = new Date(JSON.parse(readFileSync(file, 'utf8')).updated);
    return Number.isNaN(updated.getTime()) ? null : updated;
  } catch {
    return null;
  }
}

/** Whether the register should be downloaded again: missing, without a date, or older than `maxAgeDays`. */
export function indRegisterStale(now = new Date(), file = indFile(), maxAgeDays = IND_MAX_AGE_DAYS): boolean {
  const updated = indUpdatedAt(file);
  return !updated || now.getTime() - updated.getTime() > maxAgeDays * 86_400_000;
}

/** Whether a company is on the IND register; null when the register was not downloaded. `companies`: config.json's. */
export function isIndSponsor(company: string, companies: Pick<Company, 'name' | 'indName'>[] = config.companies): boolean | null {
  if (!cache) {
    if (!existsSync(indFile())) return null;
    cache = new Set((JSON.parse(readFileSync(indFile(), 'utf8')).names as string[]).map(normalize));
  }
  // config.json can map a company to its legal name on the register (e.g. Elastic → elasticsearch B.V.).
  const n = normalize(companies.find((c) => c.name === company)?.indName ?? company);
  return n.length > 1 && cache.has(n);
}
