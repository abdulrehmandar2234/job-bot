import { type Job, pool } from '@/lib/db';

// The job-bot Chrome extension (extension/ in the repo). Web pages cannot forge the Origin header,
// so a chrome-extension:// origin proves the request came from an extension the user installed.
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export const isExtensionOrigin = (origin: string | null): origin is string => !!origin && EXTENSION_ORIGIN.test(origin);

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
     ORDER BY (url = $1) DESC, (duplicate_of IS NULL) DESC, first_seen_at DESC LIMIT 1`, [url, normalizeUrl(url)]);
  const job = rows[0];
  if (!job?.duplicate_of) return job ?? null;
  const { rows: primary } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [job.duplicate_of]);
  return primary[0] ?? job;
}
