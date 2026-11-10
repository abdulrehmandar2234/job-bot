// Reads a job from the page data collected by collect.js: schema.org JobPosting JSON-LD first,
// else the page title and the selected or main text. No chrome.* calls, so node:test can test it.
import { cleanText, decodeEntities, htmlToText } from './text.js';
import { sourceFromUrl } from './url.js';

const isPosting = (n) =>
  n && typeof n === 'object' && [n['@type']].flat().some((t) => typeof t === 'string' && /(^|[/:])JobPosting$/.test(t));

/** Finds the first JobPosting in a list of JSON-LD script texts (handles arrays and @graph). Null if none. */
export function findJobPosting(jsonLdTexts) {
  for (const text of jsonLdTexts ?? []) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      continue;
    }
    const stack = [data];
    while (stack.length) {
      const n = stack.shift();
      if (Array.isArray(n)) stack.push(...n);
      else if (isPosting(n)) return n;
      else if (n && typeof n === 'object' && n['@graph']) stack.push(n['@graph']);
    }
  }
  return null;
}

const str = (v) => (typeof v === 'string' ? cleanText(decodeEntities(v)) : '');
const nameOf = (v) => (typeof v === 'string' ? str(v) : v && typeof v === 'object' ? str(v.name) : '');

// "AE" -> "United Arab Emirates": the bot matches country names, not ISO codes.
const regions = new Intl.DisplayNames(['en'], { type: 'region' });
const country = (v) => {
  const c = nameOf(v);
  if (!/^[A-Z]{2}$/.test(c)) return c;
  try {
    return regions.of(c) ?? c;
  } catch {
    return c;
  }
};

function place(loc) {
  if (typeof loc === 'string') return str(loc);
  const a = loc?.address;
  if (typeof a === 'string') return str(a);
  if (!a || typeof a !== 'object') return nameOf(loc);
  const parts = [str(a.addressLocality), str(a.addressRegion), country(a.addressCountry)].filter(Boolean);
  return [...new Set(parts)].join(', ') || nameOf(loc);
}

/** Location text from jobLocation, plus "Remote" (with the allowed countries) for TELECOMMUTE jobs. */
export function postingLocation(p) {
  const places = [p.jobLocation ?? []].flat().map(place).filter(Boolean);
  const remote = [p.jobLocationType].flat().some((t) => typeof t === 'string' && /telecommute/i.test(t));
  if (remote) {
    const where = [p.applicantLocationRequirements ?? []].flat().map(country).filter(Boolean);
    places.push(where.length ? `Remote (${where.join(', ')})` : 'Remote');
  }
  return [...new Set(places)].join('; ');
}

const isoDate = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Job fields from a JobPosting; `pageUrl` is used when the posting has no url of its own. */
export function jobFromPosting(p, pageUrl) {
  const url = typeof p.url === 'string' && /^https?:\/\//i.test(p.url) ? p.url : pageUrl;
  return {
    source: sourceFromUrl(url),
    company: nameOf(p.hiringOrganization),
    title: str(p.title),
    location: postingLocation(p),
    url,
    description: htmlToText(p.description),
    posted_at: isoDate(p.datePosted),
  };
}

// Words some job sites put before the job title in the page title ("Job Application for … at Acme": Greenhouse).
const LEAD_IN = /^(?:job application for|application for|apply for|apply to)\s+/i;

/**
 * Best guess at title and company from a page title such as "Backend Engineer at Acme | LinkedIn". "Title at
 * company" is looked for across the strong separators (| · – —) first: a plain hyphen is often part of the job
 * title itself ("Job Application for Assistant Manager - Internal Audit at Groww"). Otherwise the first two parts.
 */
export function guessFromTitle(pageTitle, siteName = '') {
  const site = String(siteName ?? '')
    .trim()
    .toLowerCase();
  const parts = (re) =>
    String(pageTitle ?? '')
      .split(re)
      .map((s) => s.trim().replace(LEAD_IN, ''))
      .filter((p) => p && p.toLowerCase() !== site);
  for (const part of parts(/\s+[|·–—]\s+/)) {
    const at = part.match(/^(.+)\s+at\s+(.+?)$/i);
    if (at) return { title: at[1].trim(), company: at[2].trim() };
  }
  const kept = parts(/\s+[|·–—-]\s+/);
  return { title: kept[0] ?? '', company: kept[1] ?? '' };
}

/**
 * The job for a page collected by collect.js. `method` says where it came from:
 * "jsonld" (structured data) or "page" (title + selected or main text, to be checked by the user).
 */
export function jobFromPage(page) {
  const posting = findJobPosting(page.jsonLd);
  if (posting) {
    const job = jobFromPosting(posting, page.url);
    if (job.title) return { method: 'jsonld', job };
  }
  const guess = guessFromTitle(page.title, page.siteName);
  const text = cleanText(page.selection) || cleanText(page.mainText);
  return {
    method: 'page',
    job: {
      source: sourceFromUrl(page.url),
      company: guess.company,
      title: guess.title,
      location: cleanText(page.locationText ?? ''),
      url: page.url,
      description: text.slice(0, 20000),
      posted_at: null,
    },
  };
}
