import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared pacing for job-site requests. Tests set `timing.scale = 0` so paced loops run instantly.
export const timing = { scale: 1 };

/**
 * Waits `ms` (scaled by `timing.scale`). With a `signal`, the wait ends at once when it aborts: the promise rejects
 * with the signal's reason and the timer is cleared, so an aborted caller (the AI budget) never waits out a backoff.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms * timing.scale);
  });
}

// Polite HTTP: one honest User-Agent, retries with backoff for 429/5xx/network errors (honouring
// Retry-After), and an on-disk ETag/Last-Modified cache so unchanged boards answer 304 instead of a full body.

export const UA = 'job-bot/0.1 (personal job search)';

export type RequestOptions = {
  /** Extra headers; a 'user-agent' here replaces the default one. */
  headers?: Record<string, string>;
  /** Total tries including the first one (default 4). */
  attempts?: number;
  /** First retry delay in ms, doubled each retry, with ±50% jitter (default 1000). */
  baseDelayMs?: number;
  /** Which HTTP statuses are worth retrying (default 429 and 5xx). Network errors are always retried. */
  retryOn?: (status: number) => boolean;
  /** Per-attempt timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Use the conditional-request cache (default true). Never used for POST. */
  cache?: boolean;
  /** HTTP method (default GET). POST is only meant for read-only search endpoints, so it is retried like a GET. */
  method?: 'GET' | 'POST';
  /** Request body for POST, sent as JSON. */
  body?: unknown;
  /** Stops the whole request (the current attempt, a backoff wait and any further retry) when it aborts; the request
   * then rejects with the signal's reason. Each attempt still has its own `timeoutMs`. */
  signal?: AbortSignal;
};

/** A final non-2xx answer. The message starts with the status, e.g. "404 https://...". */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** The start of the error response body, for APIs that explain the error there (empty when unknown). */
  readonly body: string;
  constructor(status: number, url: string, message = `${status} ${url}`, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const retryable = (status: number) => status === 429 || status >= 500;
// A Retry-After longer than this means "come back much later": give up instead of blocking the run.
const MAX_RETRY_AFTER_MS = 120_000;

/** Delay before retry number `attempt` (0-based): Retry-After when the server sent one, else backoff with jitter. */
export function retryDelay(attempt: number, baseDelayMs: number, retryAfter?: string | null, random = Math.random): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms)) return Math.max(0, ms);
  }
  return Math.round(baseDelayMs * 2 ** attempt * (0.5 + random()));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheDir = () => process.env.JOB_BOT_HTTP_CACHE || join(ROOT, 'data', 'http-cache');
const cacheFile = (url: string) => join(cacheDir(), `${createHash('sha256').update(url).digest('hex')}.json`);
type Cached = { url: string; etag: string | null; lastModified: string | null; body: string };

function readCache(url: string): Cached | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(url), 'utf8')) as Cached;
    return c.url === url ? c : null;
  } catch {
    return null;
  }
}

/** Cache entries not re-fetched for this long are deleted by pruneCache (the daily run calls it). */
export const CACHE_MAX_AGE_DAYS = 30;

/** Deletes cache entries last written more than `maxAgeDays` ago, so the on-disk ETag cache
 * (one file per URL, no eviction otherwise) does not grow forever. Returns how many were removed. */
export function pruneCache(maxAgeDays = CACHE_MAX_AGE_DAYS): number {
  let names: string[];
  try {
    names = readdirSync(cacheDir());
  } catch {
    return 0; // no cache directory yet
  }
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = join(cacheDir(), name);
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file);
        removed++;
      }
    } catch {
      // a parallel run removed it first
    }
  }
  return removed;
}

function writeCache(entry: Cached) {
  const file = cacheFile(entry.url);
  mkdirSync(dirname(file), { recursive: true });
  // Write then rename, so parallel probes never read a half-written file.
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(entry));
  renameSync(`${file}.${process.pid}.tmp`, file);
}

/** GET (or a read-only POST) with retries and, for GET, the conditional-request cache.
 * Resolves with the body text of a 2xx (or a 304 from cache). */
export async function request(
  url: string,
  opts: RequestOptions = {},
): Promise<{ status: number; body: string; fromCache: boolean; url: string }> {
  const { attempts = 4, baseDelayMs = 1000, retryOn = retryable, timeoutMs = 30_000, method = 'GET', signal } = opts;
  const cache = method === 'GET' && (opts.cache ?? true);
  const host = new URL(url).host;
  const cached = cache ? readCache(url) : null;
  const headers: Record<string, string> = { 'user-agent': UA };
  if (method === 'POST') Object.assign(headers, { 'content-type': 'application/json', accept: 'application/json' });
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

  let last = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
      });
    } catch (e) {
      // Aborted from outside: no retry, and the caller gets its own reason back (not fetch's generic AbortError).
      if (signal?.aborted) throw signal.reason;
      last = (e as Error).message;
      if (attempt + 1 < attempts) await sleep(retryDelay(attempt, baseDelayMs), signal);
      continue;
    }
    if (res.status === 304 && cached) return { status: 304, body: cached.body, fromCache: true, url };
    if (res.ok) {
      const body = await res.text();
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (cache && (etag || lastModified)) writeCache({ url, etag, lastModified, body });
      // `url` is where redirects ended up (the dead-link check reads it).
      return { status: res.status, body, fromCache: false, url: res.url || url };
    }
    if (!retryOn(res.status)) {
      const body = await res.text().catch(() => '');
      throw new HttpError(res.status, url, undefined, body.slice(0, 2000));
    }
    last = String(res.status);
    const wait = retryDelay(attempt, baseDelayMs, res.headers.get('retry-after'));
    if (wait > MAX_RETRY_AFTER_MS) {
      throw new HttpError(res.status, url, `${res.status} ${host} asked to retry after ${Math.round(wait / 1000)}s; giving up on ${url}`);
    }
    if (attempt + 1 < attempts) await sleep(wait, signal);
  }
  throw new Error(`${host}: gave up after ${attempts} attempts (last: ${last}) ${url}`);
}

/** `url` with its query string hidden: an API key may live there (e.g. Adzuna), and parse errors end up in fetch_runs. */
const stripQuery = (url: string) => {
  const i = url.indexOf('?');
  return i === -1 ? url : `${url.slice(0, i)}?…`;
};

/** JSON.parse that names the (query-stripped) URL, so "Unexpected token …" says which site answered with non-JSON. */
function parseJson<T>(body: string, url: string): T {
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error(`invalid JSON from ${stripQuery(url)}: ${(e as Error).message}`);
  }
}

export const getText = async (url: string, opts?: RequestOptions) => (await request(url, opts)).body;
export const getJson = async <T = any>(url: string, opts?: RequestOptions): Promise<T> => parseJson((await request(url, opts)).body, url);
/** POST a JSON body and parse the JSON answer. Retried like a GET, never cached. */
export const postJson = async <T = any>(url: string, body: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> =>
  parseJson((await request(url, { ...opts, method: 'POST', body })).body, url);
