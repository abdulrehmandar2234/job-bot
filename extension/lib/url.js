// URL helpers shared by the popup and the side panel. No chrome.* calls.

/** True for an absolute http(s) URL. */
export function isHttpUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/**
 * Query parameters (compared lowercase) that name the job itself on sites where the path is the same for every
 * job: Greenhouse and Ashby embeds (gh_jid, ashby_jid), Indeed (jk, vjk), Glassdoor (jl), LinkedIn's split view
 * (currentJobId), Taleo (job), SuccessFactors (career_job_req_id) and generic job id names. Every other parameter
 * is tracking. Same list as JOB_ID_PARAMS in web/lib/extension.ts (web/tests/lib/extension-url.test.ts checks).
 */
export const JOB_ID_PARAMS = [
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

/**
 * The URL without hash, trailing slash and tracking parameters: only the job id parameters (JOB_ID_PARAMS) stay,
 * lowercased and sorted, so `?utm_source=x&gh_jid=5` and `?gh_jid=5` are the same job and `?gh_jid=6` is another.
 * Null for a URL that is not http(s). Same rule as normalizeUrl in web/lib/extension.ts.
 */
export function normalizeUrl(url) {
  if (!isHttpUrl(url)) return null;
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  const ids = [...u.searchParams]
    .map(([k, v]) => [k.toLowerCase(), v])
    .filter(([k, v]) => v !== '' && JOB_ID_PARAMS.includes(k))
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  return `${u.protocol}//${u.host}${path}${ids.length ? `?${new URLSearchParams(ids)}` : ''}`;
}

/**
 * Whether the tab a job was shown for is still the active tab, on the same job page (ignoring tracking parameters
 * and hash, but not a job id parameter: another ?gh_jid= on the same careers page is another job).
 * The side panel checks this before filling, so one job's answers never go into another tab's form.
 */
export function sameTab(shown, active) {
  return Boolean(shown && active && shown.id === active.id && normalizeUrl(shown.url) === normalizeUrl(active.url));
}

/**
 * The origins of a page's iframes that differ from the page itself (http(s) only, each once), as permission
 * patterns. A form embedded from another site (a Greenhouse or Workday iframe) needs access to that site too.
 */
export function frameOrigins(pageUrl, frameUrls) {
  if (!isHttpUrl(pageUrl)) return [];
  const own = new URL(pageUrl).origin;
  const out = new Set();
  for (const u of frameUrls ?? []) if (isHttpUrl(u) && new URL(u).origin !== own) out.add(`${new URL(u).origin}/*`);
  return [...out];
}

// Job boards the bot knows by name; any other site is stored with the source "extension".
const BOARDS = [
  ['bayt.com', 'bayt'],
  ['linkedin.com', 'linkedin'],
  ['gulftalent.com', 'gulftalent'],
  ['naukrigulf.com', 'naukrigulf'],
  ['indeed.com', 'indeed'],
  ['glassdoor.com', 'glassdoor'],
  ['greenhouse.io', 'greenhouse'],
  ['lever.co', 'lever'],
  ['ashbyhq.com', 'ashby'],
  ['workable.com', 'workable'],
  ['recruitee.com', 'recruitee'],
  ['smartrecruiters.com', 'smartrecruiters'],
  ['wellfound.com', 'wellfound'],
  ['himalayas.app', 'himalayas'],
  ['remotive.com', 'remotive'],
  ['remoteok.com', 'remoteok'],
  ['dubizzle.com', 'dubizzle'],
];

/** Source name for a job URL's hostname: a known board ("gulftalent"), else "extension". */
export function sourceFromUrl(url) {
  if (!isHttpUrl(url)) return 'extension';
  const host = new URL(url).hostname.toLowerCase();
  const hit = BOARDS.find(([domain]) => host === domain || host.endsWith(`.${domain}`));
  return hit ? hit[1] : 'extension';
}
