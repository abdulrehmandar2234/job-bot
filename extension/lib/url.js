// URL helpers shared by the popup and the side panel. No chrome.* calls.

/** True for an absolute http(s) URL. */
export function isHttpUrl(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** The URL without query, hash and trailing slash, used to find a job whose tracking parameters differ. */
export function normalizeUrl(url) {
  if (!isHttpUrl(url)) return null;
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/**
 * Whether the tab a job was shown for is still the active tab, on the same page (ignoring query and hash).
 * The side panel checks this before filling, so one job's answers never go into another tab's form.
 */
export function sameTab(shown, active) {
  return Boolean(shown && active && shown.id === active.id && normalizeUrl(shown.url) === normalizeUrl(active.url));
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
