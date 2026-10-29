import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROOT } from '@/lib/bot';
import { type Job, pool } from '@/lib/db';

// The job-bot Chrome extension (extension/ in the repo). Web pages cannot forge the Origin header, and the
// manifest's public "key" pins the extension id, so only this extension (not any other one the user installed)
// may add jobs or read cover letters and answers. JOB_BOT_EXTENSION_ID (web/.env.local) overrides it after a key change.
export const EXTENSION_ID = 'fmkmpckdcfhibobdiffankccildkcnij';

const extensionId = () => process.env.JOB_BOT_EXTENSION_ID?.trim() || EXTENSION_ID;

export const isExtensionOrigin = (origin: string | null): origin is string =>
  /^[a-p]{32}$/.test(extensionId()) && origin === `chrome-extension://${extensionId()}`;

export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The URL without query, hash and trailing slash (same rule as extension/lib/url.js). */
export function normalizeUrl(url: string) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

// Same normalization in SQL, for the stored urls.
const NORMALIZED = `rtrim(split_part(split_part(url, '#', 1), '?', 1), '/')`;

/**
 * The job posted at `url`: an exact url match first, else one whose url only differs in query, hash or
 * trailing slash. A copy found on another site resolves to its primary row, which holds the prepared material.
 */
export async function findJobByUrl(url: string): Promise<Job | null> {
  const { rows } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE url = $1 OR ${NORMALIZED} = $2
     ORDER BY (url = $1) DESC, (duplicate_of IS NULL) DESC, first_seen_at DESC LIMIT 1`,
    [url, normalizeUrl(url)],
  );
  const job = rows[0];
  if (!job?.duplicate_of) return job ?? null;
  const { rows: primary } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [job.duplicate_of]);
  return primary[0] ?? job;
}

/** What the extension may type into application forms: name and contact details. */
export type FillProfile = { name: string; email: string; phone: string; linkedin: string; location: string };

const readJson = (file: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/**
 * Name and contact from cv/master.json; cv/applicant.json currentLocation wins for the location.
 * Missing files or fields give empty strings, which the extension leaves unfilled.
 */
export function fillProfile(root = BOT_ROOT): FillProfile {
  const cv = readJson(join(root, 'cv', 'master.json'));
  const contact = (cv.contact ?? {}) as Record<string, unknown>;
  const facts = readJson(join(root, 'cv', 'applicant.json'));
  return {
    name: str(cv.name),
    email: str(contact.email),
    phone: str(contact.phone),
    linkedin: str(contact.linkedin),
    location: str(facts.currentLocation) || str(contact.location),
  };
}
