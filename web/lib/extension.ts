import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROOT } from '@/lib/bot';
import { type Job, pool } from '@/lib/db';
import { applicantFile, masterFile } from '@/lib/settings';

// The job-bot Chrome extension (extension/ in the repo). Web pages cannot forge the Origin header, and the
// manifest's public "key" pins the extension id, so only this extension (not any other one the user installed)
// may add jobs or read cover letters and answers. JOB_BOT_EXTENSION_ID (web/.env.local) overrides it after a key change.
export const EXTENSION_ID = 'fmkmpckdcfhibobdiffankccildkcnij';

const extensionId = () => process.env.JOB_BOT_EXTENSION_ID?.trim() || EXTENSION_ID;

export const isExtensionOrigin = (origin: string | null): origin is string =>
  /^[a-p]{32}$/.test(extensionId()) && origin === `chrome-extension://${extensionId()}`;

// POST /api/import from a job-site origin must also carry this token (header `x-import-token`). The CORS origin
// check alone lets any script that runs on an allowed job site (ads, trackers) import jobs; the token is known only
// to the collector script the dashboard itself serves (/api/bayt-script embeds it), so other scripts cannot send it
// blindly. A script on that site written to attack job-bot could load the collector and capture the token: the
// token raises the bar for drive-by posts, it is not authentication.
// The extension origin needs no token: web pages cannot forge a chrome-extension:// Origin header.
// The token is random, generated on first use and kept in data/import-token (data/ is gitignored). Never put it in a URL.
const tokenFile = () => join(BOT_ROOT, 'data', 'import-token');

/** The local import token, creating data/import-token on first use (or when its content is not a token). */
export function importToken(): string {
  try {
    const token = readFileSync(tokenFile(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  } catch {
    // Missing file: generate one below.
  }
  const token = randomBytes(32).toString('hex');
  mkdirSync(join(BOT_ROOT, 'data'), { recursive: true });
  writeFileSync(tokenFile(), `${token}\n`, { mode: 0o600 });
  return token;
}

/** Whether `value` (the x-import-token header) is the local import token. Compares in constant time. */
export function isImportToken(value: string | null): boolean {
  if (typeof value !== 'string' || !value) return false;
  const token = Buffer.from(importToken());
  const given = Buffer.from(value);
  return given.length === token.length && timingSafeEqual(given, token);
}

export function isHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Query parameters (compared lowercase) that name the job itself on sites where the path is the same for every
 * job: Greenhouse and Ashby embeds on a company's own careers page (gh_jid, ashby_jid), Indeed (jk, vjk),
 * Glassdoor (jl), LinkedIn's split view (currentJobId), Taleo (job), SuccessFactors (career_job_req_id) and the
 * generic jobId / job_id / jid / id / postingId / reqId / requisitionId of smaller ATSs. Every other parameter
 * (utm_*, ref, source, trk, ...) is tracking and dropped. Keeping one too many only costs a loose match (the job
 * shows as not in job-bot); dropping a job id would show another job's letter and answers, so this errs on keeping.
 * Same list as JOB_ID_PARAMS in extension/lib/url.js (web/tests/lib/extension-url.test.ts checks).
 */
export const JOB_ID_PARAMS: readonly string[] = [
  'gh_jid',
  'ashby_jid',
  'jk',
  'vjk',
  'jl',
  'currentjobid',
  'job',
  'jobid',
  'job_id',
  'jid',
  'id',
  'postingid',
  'posting_id',
  'reqid',
  'req_id',
  'requisitionid',
  'career_job_req_id',
];

/** The URL without hash, trailing slash and query, so the same as `NORMALIZED` below in SQL. */
const pathOnly = (u: URL) => `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;

/**
 * The URL without hash, trailing slash and tracking parameters: only the job id parameters (JOB_ID_PARAMS) stay,
 * lowercased and sorted, so `?utm_source=x&gh_jid=5` and `?gh_jid=5` are the same job and `?gh_jid=6` is another.
 * Same rule as normalizeUrl in extension/lib/url.js.
 */
export function normalizeUrl(url: string) {
  const u = new URL(url);
  const ids = [...u.searchParams]
    .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    .filter(([k, v]) => v !== '' && JOB_ID_PARAMS.includes(k))
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  return `${pathOnly(u)}${ids.length ? `?${new URLSearchParams(ids)}` : ''}`;
}

const normalizedOrNull = (url: string) => {
  try {
    return normalizeUrl(url);
  } catch {
    return null; // a stored url that is not a URL never matches loosely
  }
};

// The path-only normalization (pathOnly above) in SQL, for the stored urls: it finds the candidates through an
// index (src/migrations/009_url_index.sql), and normalizeUrl then keeps those with the same job id parameters.
const NORMALIZED = `rtrim(split_part(split_part(url, '#', 1), '?', 1), '/')`;

/**
 * Application forms that live at another URL than the posting, per ATS host: Lever `/apply`, Ashby `/application`,
 * Workday `/apply` and its steps (`/apply/applyManually`). Greenhouse's `#app` needs no rule (the hash is dropped
 * anyway). Kept tight on purpose: a rule on every host would make `/apply` pages of unrelated sites match.
 * Same list as APPLY_STEPS in extension/lib/url.js (web/tests/lib/extension-url.test.ts checks).
 */
export const APPLY_STEPS: ReadonlyArray<{ host: RegExp; path: RegExp }> = [
  { host: /(^|\.)lever\.co$/, path: /\/apply$/ },
  { host: /(^|\.)ashbyhq\.com$/, path: /\/application$/ },
  { host: /(^|\.)(myworkdayjobs|myworkdaysite)\.com$/, path: /\/apply(\/[^/]+){0,2}$/ },
];

/** The posting URL of an application-form URL (`.../apply` → `...`), keeping the query, or null when it is not one. */
export function postingUrl(url: string): string | null {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  const rule = APPLY_STEPS.find((r) => r.host.test(u.hostname.toLowerCase()) && r.path.test(path));
  if (!rule) return null;
  return `${u.protocol}//${u.host}${path.replace(rule.path, '')}${u.search}`;
}

type Candidate = Pick<Job, 'id' | 'url' | 'duplicate_of'>;

/**
 * The job posted at `url`, or, for an application form at another URL than the posting (Lever `/apply`, Ashby
 * `/application`, a Workday apply step: postingUrl), the job posted at the posting URL. The job id parameter rule
 * of normalizeUrl applies to both.
 */
export async function findJobByUrl(url: string): Promise<Job | null> {
  const job = await findJobAt(url);
  if (job) return job;
  const posting = postingUrl(url);
  return posting ? findJobAt(posting) : null;
}

/**
 * The job posted at `url`: an exact url match first, else one whose url only differs in tracking parameters, hash
 * or trailing slash (normalizeUrl). When several different jobs match that loosely (they differ in a parameter
 * normalizeUrl drops) there is no telling which one the page shows, so the answer is null, never a guess.
 * A copy found on another site resolves to its primary row, which holds the prepared material.
 */
async function findJobAt(url: string): Promise<Job | null> {
  const { rows } = await pool.query<Candidate>(
    `SELECT id, url, duplicate_of FROM jobs WHERE url = $1 OR ${NORMALIZED} = $2
     ORDER BY (url = $1) DESC, (duplicate_of IS NULL) DESC, first_seen_at DESC`,
    [url, pathOnly(new URL(url))],
  );
  let job: Candidate | undefined = rows.find((r) => r.url === url);
  if (!job) {
    const want = normalizeUrl(url);
    const loose = rows.filter((r) => normalizedOrNull(r.url) === want);
    if (new Set(loose.map((r) => r.duplicate_of ?? r.id)).size !== 1) return null;
    job = loose[0];
  }
  for (const id of job.duplicate_of ? [job.duplicate_of, job.id] : [job.id]) {
    const { rows: found } = await pool.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
    if (found[0]) return found[0];
  }
  return null;
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
 * Name and contact from cv/master.json; cv/applicant.json currentLocation wins for the location (or the files
 * JOB_BOT_MASTER / JOB_BOT_APPLICANT name, see lib/settings.ts).
 * Missing files or fields give empty strings, which the extension leaves unfilled.
 */
export function fillProfile(files = { master: masterFile(), applicant: applicantFile() }): FillProfile {
  const cv = readJson(files.master);
  const contact = (cv.contact ?? {}) as Record<string, unknown>;
  const facts = readJson(files.applicant);
  return {
    name: str(cv.name),
    email: str(contact.email),
    phone: str(contact.phone),
    linkedin: str(contact.linkedin),
    location: str(facts.currentLocation) || str(contact.location),
  };
}
