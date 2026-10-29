import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared pacing for job-site requests. Tests set `timing.scale = 0` so paced loops run instantly.
export const timing = { scale: 1 };
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * timing.scale));

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
  /** Use the conditional-request cache (default true). */
  cache?: boolean;
};

/** A final non-2xx answer. The message starts with the status, e.g. "404 https://...". */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, message = `${status} ${url}`) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
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

function writeCache(entry: Cached) {
  const file = cacheFile(entry.url);
  mkdirSync(dirname(file), { recursive: true });
  // Write then rename, so parallel probes never read a half-written file.
  writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(entry));
  renameSync(`${file}.${process.pid}.tmp`, file);
}

/** GET with retries and the conditional-request cache. Resolves with the body text of a 2xx (or a 304 from cache). */
export async function request(url: string, opts: RequestOptions = {}): Promise<{ status: number; body: string; fromCache: boolean }> {
  const { attempts = 4, baseDelayMs = 1000, retryOn = retryable, timeoutMs = 30_000, cache = true } = opts;
  const host = new URL(url).host;
  const cached = cache ? readCache(url) : null;
  const headers: Record<string, string> = { 'user-agent': UA };
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers[k.toLowerCase()] = v;
  if (cached?.etag) headers['if-none-match'] = cached.etag;
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;

  let last = '';
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      last = (e as Error).message;
      if (attempt + 1 < attempts) await sleep(retryDelay(attempt, baseDelayMs));
      continue;
    }
    if (res.status === 304 && cached) return { status: 304, body: cached.body, fromCache: true };
    if (res.ok) {
      const body = await res.text();
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (cache && (etag || lastModified)) writeCache({ url, etag, lastModified, body });
      return { status: res.status, body, fromCache: false };
    }
    if (!retryOn(res.status)) throw new HttpError(res.status, url);
    last = String(res.status);
    const wait = retryDelay(attempt, baseDelayMs, res.headers.get('retry-after'));
    if (wait > MAX_RETRY_AFTER_MS) {
      throw new HttpError(res.status, url, `${res.status} ${host} asked to retry after ${Math.round(wait / 1000)}s; giving up on ${url}`);
    }
    if (attempt + 1 < attempts) await sleep(wait);
  }
  throw new Error(`${host}: gave up after ${attempts} attempts (last: ${last}) ${url}`);
}

export const getText = async (url: string, opts?: RequestOptions) => (await request(url, opts)).body;
export const getJson = async <T = any>(url: string, opts?: RequestOptions): Promise<T> => JSON.parse((await request(url, opts)).body);
