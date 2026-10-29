import { HttpError, request, type RequestOptions } from './http.ts';
import { UA as LINKEDIN_UA } from './linkedin.ts';
import type { Job } from '../types.ts';

// Dead-link check: is a stored posting still open? Each ATS is asked through its own API (a 404 there is a clear
// answer); other boards get a GET of the job page. Only a clear answer counts: network errors, 5xx, 403s and
// rate limits are `unknown`, and an unknown result never expires a job.

export type OpenState = 'open' | 'closed' | 'unknown';
export type OpenResult = { state: OpenState; reason: string };
export type OpenJob = Pick<Job, 'id' | 'source' | 'url'>;

const open = (reason: string): OpenResult => ({ state: 'open', reason });
const closed = (reason: string): OpenResult => ({ state: 'closed', reason });
const unknown = (reason: string): OpenResult => ({ state: 'unknown', reason });

// Few tries and no cache: a 304 from the cache would hide a posting that has gone.
const OPTS: RequestOptions = { cache: false, attempts: 2, baseDelayMs: 2000, timeoutMs: 20_000 };

/** Text a job page shows once it stops taking applications. Scripts and styles are ignored. */
export const CLOSED_TEXT = new RegExp(
  [
    'no longer accepting applications',
    '(job|posting|position|vacancy|listing|advert) (has )?expired',
    '(job|position|role|vacancy) has been filled',
    '(job|posting|position|vacancy|listing) is no longer (available|open|active)',
    '(job|posting|position|vacancy) (has been|is) closed',
    'applications (are|have) (now )?closed',
  ].join('|'),
  'i',
);

export function closedText(html: string): string | null {
  const text = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
  return text.match(CLOSED_TEXT)?.[0].toLowerCase() ?? null;
}

/**
 * A redirect from a job URL to a generic careers or search page (or Greenhouse's `?error=true`) means the posting
 * is gone. A redirect that keeps the job's id (e.g. to an apply page) does not.
 */
export function genericRedirect(from: string, to: string): boolean {
  const a = new URL(from);
  const b = new URL(to);
  const trim = (p: string) => p.replace(/\/+$/, '');
  if (a.host === b.host && trim(a.pathname) === trim(b.pathname)) return /[?&]error=true\b/.test(b.search);
  if (/[?&]error=true\b/.test(b.search)) return true;
  const segments = a.pathname.split('/').filter(Boolean);
  const key = segments.findLast((s) => /\d/.test(s)) ?? segments.at(-1);
  if (key && decodeURIComponent(to).includes(decodeURIComponent(key))) return false;
  const path = trim(b.pathname);
  return path === '' || /(^|[/_-])(careers?|jobs?|positions|openings|vacancies|join-us|search)$/i.test(path);
}

/** Errors become answers: 404/410 = closed, anything else = unknown. */
function fromError(e: unknown, what: string): OpenResult {
  if (e instanceof HttpError && (e.status === 404 || e.status === 410)) return closed(`${what} ${e.status}`);
  return unknown(`${what}: ${(e as Error).message}`);
}

/** GET the job page: 404/410, a "no longer accepting applications" text or a redirect to a careers page = closed. */
async function page(url: string, what = 'job page', opts: RequestOptions = {}): Promise<OpenResult> {
  const res = await request(url, { ...OPTS, ...opts });
  const text = closedText(res.body);
  if (text) return closed(`${what} says "${text}"`);
  if (res.url !== url && genericRedirect(url, res.url)) return closed(`redirected to ${res.url}`);
  return open(`${what} ${res.status}`);
}

/** An ATS endpoint for one posting: 200 = open, 404 = closed. */
async function api(url: string, what: string): Promise<OpenResult> {
  const res = await request(url, OPTS);
  return open(`${what} ${res.status}`);
}

// Ashby and Workable have no public endpoint per posting, so a company's whole board is loaded once per run and
// shared by its jobs.
const boards = new Map<string, Promise<Set<string>>>();
function board(url: string, ids: (data: any) => string[], opts: RequestOptions = OPTS) {
  if (!boards.has(url)) {
    const p = request(url, opts).then((r) => new Set(ids(JSON.parse(r.body)).map(String)));
    p.catch(() => boards.delete(url)); // a failed load is retried by the next job
    boards.set(url, p);
  }
  return boards.get(url)!;
}
async function listed(url: string, id: string, what: string, ids: (data: any) => string[], opts?: RequestOptions) {
  return (await board(url, ids, opts)).has(id) ? open(`listed on the ${what} board`) : closed(`no longer on the ${what} board`);
}

// A LinkedIn 429 means the guest endpoints are throttling this IP: stop LinkedIn checks for the rest of the run.
let linkedinStopped = false;

/** Forgets per-run state (loaded boards, the LinkedIn stop). Each CLI run starts fresh anyway; tests call this. */
export function resetOpenChecks() {
  boards.clear();
  linkedinStopped = false;
}

async function linkedin(postingId: string): Promise<OpenResult> {
  if (linkedinStopped) return unknown('LinkedIn rate limit hit earlier in this run');
  try {
    return await page(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${postingId}`, 'LinkedIn posting', {
      headers: { 'user-agent': LINKEDIN_UA, 'accept-language': 'en' },
      retryOn: (s) => s >= 500,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) {
      linkedinStopped = true;
      return unknown('429 LinkedIn rate limit: no more LinkedIn checks in this run');
    }
    throw e;
  }
}

/** Workday job URL (…myworkdayjobs.com/[locale/]<site>/job/…) → the CXS API URL for that posting, or null. */
export function workdayApiUrl(url: string): string | null {
  const u = new URL(url);
  const tenant = u.host.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/)?.[1];
  const parts = u.pathname.split('/').filter(Boolean);
  const at = parts.indexOf('job');
  if (!tenant || at < 1) return null;
  return `https://${u.host}/wday/cxs/${tenant}/${parts[at - 1]}/${parts.slice(at).join('/')}`;
}

/** The URL a check requests first (pacing is per host) and the check itself. */
export function openCheck(job: OpenJob): { url: string; run: () => Promise<OpenResult> } {
  const [, token = '', ...rest] = job.id.split(':');
  const pid = rest.join(':');
  const t = encodeURIComponent(token);
  const p = encodeURIComponent(pid);
  const via = (url: string, run: () => Promise<OpenResult>) => ({ url, run });
  switch (job.source) {
    case 'greenhouse': {
      const url = `https://boards-api.greenhouse.io/v1/boards/${t}/jobs/${p}`;
      return via(url, () => api(url, 'Greenhouse API'));
    }
    case 'lever': {
      const url = `https://api.lever.co/v0/postings/${t}/${p}`;
      return via(url, () => api(url, 'Lever API'));
    }
    case 'recruitee': {
      const url = `https://${t}.recruitee.com/api/offers/${p}`;
      return via(url, () => api(url, 'Recruitee API'));
    }
    case 'smartrecruiters': {
      const url = `https://api.smartrecruiters.com/v1/companies/${t}/postings/${p}`;
      return via(url, () => api(url, 'SmartRecruiters API'));
    }
    case 'ashby': {
      const url = `https://api.ashbyhq.com/posting-api/job-board/${t}`;
      return via(url, () => listed(url, pid, 'Ashby', (d) => (d.jobs ?? []).map((j: any) => j.id)));
    }
    case 'workable': {
      // Workable throttles hard (Cloudflare, sometimes as a 403), so its retries are slow; a 403 stays unknown.
      const url = `https://apply.workable.com/api/v1/widget/accounts/${t}`;
      return via(url, () =>
        listed(url, pid, 'Workable', (d) => (d.jobs ?? []).map((j: any) => j.shortcode), { ...OPTS, baseDelayMs: 15_000 }),
      );
    }
    case 'workday': {
      const url = workdayApiUrl(job.url);
      if (url) return via(url, () => api(url, 'Workday API'));
      break;
    }
    case 'linkedin': {
      const lid = job.id.split(':')[1] ?? '';
      return via(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${lid}`, () => linkedin(lid));
    }
  }
  return via(job.url, () => page(job.url));
}

/** Is the posting still open? Never throws: anything unclear is `unknown`. */
export async function isOpen(job: OpenJob): Promise<OpenResult> {
  try {
    return await openCheck(job).run();
  } catch (e) {
    return fromError(e, job.source);
  }
}
