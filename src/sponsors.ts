import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config, path, type Company } from './config.ts';
import { getText } from './sources/http.ts';

// Dutch IND public register of recognised sponsors (erkend referent) for highly skilled migrants.
// Only these employers can sponsor a Dutch highly-skilled-migrant visa.
const IND_URL = 'https://ind.nl/en/public-register-recognised-sponsors/public-register-regular-labour-and-highly-skilled-migrants';
const FILE = path('data', 'ind-sponsors.json');

const normalize = (name: string) =>
  name
    .toLowerCase()
    .replace(/["'.,()&@]/g, ' ')
    .replace(/\b(b ?v|n ?v|holding|holdings|netherlands|nederland|benelux|europe|international|group|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export async function updateIndRegister() {
  const html = await getText(IND_URL);
  const names = [...html.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((m) => m[1].replace(/""/g, '"').trim());
  if (names.length < 1000) throw new Error(`IND register looks wrong: only ${names.length} rows parsed`);
  writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), names }, null, 0));
  return names.length;
}

let cache: Set<string> | null = null;

/** Whether a company is on the IND register; null when the register was not downloaded. `companies`: config.json's. */
export function isIndSponsor(company: string, companies: Pick<Company, 'name' | 'indName'>[] = config.companies): boolean | null {
  if (!cache) {
    if (!existsSync(FILE)) return null;
    cache = new Set((JSON.parse(readFileSync(FILE, 'utf8')).names as string[]).map(normalize));
  }
  // config.json can map a company to its legal name on the register (e.g. Elastic → elasticsearch B.V.).
  const n = normalize(companies.find((c) => c.name === company)?.indName ?? company);
  return n.length > 1 && cache.has(n);
}
