import { getJson, postJson, sleep } from './http.ts';
import { config, type Company } from '../config.ts';
import type { RawJob, SalaryPeriod } from '../types.ts';
import { structuredSalary } from '../salary.ts';
import { titleOk } from '../match.ts';
import { loadProfile, remoteFrom, remoteFromCode } from '../profile.ts';
import { effectiveRemoteRules } from '../regions.ts';

export type { RawJob };

/**
 * A source's postings. `partialError` is set when a later page or detail call failed: the postings collected
 * before it are still returned (and saved), and fetch records the failure in fetch_runs.errors.
 */
export type Fetched = RawJob[] & { partialError?: string };

/** Keeps what a source collected before `e`; with nothing collected yet, the error is simply rethrown. */
export function partial(jobs: RawJob[], e: unknown): Fetched {
  if (!jobs.length) throw e;
  return Object.assign(jobs, { partialError: `partial: kept ${jobs.length} postings, then ${(e as Error).message}` });
}

// Named entities job boards use; any other one is left as written. Numeric ones (&#39; &#x27;) are all decoded.
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  bull: '•',
  middot: '·',
  euro: '€',
  pound: '£',
};

/** Decodes one layer of HTML entities: named (&amp;), decimal (&#39;) and hex (&#x27;). */
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== '#') return Object.hasOwn(ENTITIES, e) ? ENTITIES[e] : whole;
    const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });

// Block tags end a line: match.ts's language, visa and remote rules read phrases within one line or sentence
// ([^.\n]{0,N}), so list items and paragraphs must not run together into one.
const BLOCK_TAG = /<\/?(p|li|ul|ol|div|h[1-6]|tr|table|section|article|blockquote)\b[^>]*>|<br\s*\/?>/gi;

/**
 * HTML (or escaped HTML) as plain text, one line per block. Escaped HTML, as Greenhouse and Arbeitnow send it
 * ("&lt;p&gt;Node &amp;amp; React&lt;/p&gt;"), is unescaped first, then its tags are dropped and the second layer
 * of entities decoded. Real HTML is only decoded after its tags are gone, so "a &lt;b&gt; c" keeps its text.
 */
export function stripHtml(html: string): string {
  const escaped = !/<[a-z!/]/i.test(html) && /&lt;\/?[a-z]/i.test(html);
  const text = (escaped ? decodeEntities(html) : html)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(BLOCK_TAG, '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

async function greenhouse(c: Company): Promise<RawJob[]> {
  const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${c.token}/jobs?content=true`);
  return data.jobs.map((j: any) => ({
    id: `greenhouse:${c.token}:${j.id}`,
    source: 'greenhouse',
    company: c.name,
    title: j.title,
    location: [j.location?.name, ...(j.offices ?? []).map((o: any) => o.name)].filter(Boolean).join(' / '),
    url: j.absolute_url,
    description: stripHtml(j.content ?? ''),
    // updated_at changes on every edit; first_published is when the job actually went live.
    posted_at: j.first_published ?? j.updated_at ?? null,
  }));
}

async function lever(c: Company): Promise<RawJob[]> {
  const data = await getJson(`https://api.lever.co/v0/postings/${c.token}?mode=json`);
  return data.map((j: any) => ({
    id: `lever:${c.token}:${j.id}`,
    source: 'lever',
    company: c.name,
    title: j.text,
    location: [j.categories?.location, ...(j.categories?.allLocations ?? [])].filter(Boolean).join(' / '),
    url: j.hostedUrl,
    description: [j.descriptionPlain, ...(j.lists ?? []).map((l: any) => `${l.text}\n${stripHtml(l.content)}`), j.additionalPlain]
      .filter(Boolean)
      .join('\n'),
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    salary: leverSalary(j.salaryRange),
  }));
}

/** Lever's optional salaryRange: { min, max, currency, interval: 'per-year-salary' | 'per-month-salary' | 'per-hour-wage' ... }. */
function leverSalary(r: any) {
  const period: SalaryPeriod | null = /year|annual/i.test(r?.interval ?? '')
    ? 'year'
    : /month/i.test(r?.interval ?? '')
      ? 'month'
      : /hour/i.test(r?.interval ?? '')
        ? 'hour'
        : null;
  return period ? structuredSalary(r.min, r.max, r.currency, period) : null;
}

async function ashby(c: Company): Promise<RawJob[]> {
  const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${c.token}`);
  return data.jobs.map((j: any) => ({
    id: `ashby:${c.token}:${j.id}`,
    source: 'ashby',
    company: c.name,
    title: j.title,
    location: [j.location, ...(j.secondaryLocations ?? []).map((l: any) => l.location)].filter(Boolean).join(' / '),
    url: j.jobUrl,
    description: j.descriptionPlain ?? stripHtml(j.descriptionHtml ?? ''),
    posted_at: j.publishedAt ?? null,
  }));
}

async function recruitee(c: Company): Promise<RawJob[]> {
  const data = await getJson(`https://${c.token}.recruitee.com/api/offers/`);
  return data.offers.map((j: any) => ({
    id: `recruitee:${c.token}:${j.id}`,
    source: 'recruitee',
    company: c.name,
    title: j.title,
    location: [j.location, ...(j.locations ?? []).map((l: any) => [l.city, l.country].filter(Boolean).join(', '))]
      .filter(Boolean)
      .join(' / '),
    url: j.careers_url,
    description: stripHtml(`${j.description ?? ''}\n${j.requirements ?? ''}`),
    posted_at: toIso(j.published_at ?? j.created_at),
  }));
}

// Workable throttles hard (Cloudflare 1015, sometimes as a 403), so calls are spaced out and retried slowly.
let workableLast = 0;
async function workable(c: Company): Promise<RawJob[]> {
  const wait = workableLast + 3000 - Date.now();
  if (wait > 0) await sleep(wait);
  workableLast = Date.now();
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${c.token}?details=true`, {
    baseDelayMs: 15_000,
    retryOn: (s) => s === 429 || s === 403 || s >= 500,
  });
  return data.jobs.map((j: any) => ({
    id: `workable:${c.token}:${j.shortcode}`,
    source: 'workable',
    company: c.name,
    title: j.title,
    location: [
      [j.city, j.country].filter(Boolean).join(', '),
      ...(j.locations ?? []).map((l: any) => [l.city, l.country].filter(Boolean).join(', ')),
    ]
      .filter(Boolean)
      .join(' / '),
    url: j.url ?? j.shortlink ?? `https://apply.workable.com/${c.token}/j/${j.shortcode}/`,
    description: stripHtml(j.description ?? ''),
    posted_at: toIso(j.published_on ?? j.created_at),
  }));
}

/** Detail requests per company (Workday, SmartRecruiters), and the pause before each one. */
const MAX_DETAILS = 40;
const DETAIL_PAUSE_MS = 300;

// The list endpoint has no descriptions, so details are fetched only for postings that could pass the filters,
// at most MAX_DETAILS of them (the newest), paced like Workday's.
async function smartrecruiters(c: Company): Promise<RawJob[]> {
  const base = `https://api.smartrecruiters.com/v1/companies/${c.token}/postings`;
  const list: any[] = [];
  let listError: unknown;
  for (let offset = 0; ; offset += 100) {
    let page: any;
    try {
      page = await getJson(`${base}?limit=100&offset=${offset}`);
    } catch (e) {
      if (!list.length) throw e;
      listError = e; // later list page: go on with the postings already listed
      break;
    }
    list.push(...page.content);
    if (offset + 100 >= page.totalFound || offset >= 1000) break;
  }
  // `where` also accepts remote postings open to the candidate, as for Workday: fullLocation is "Remote" for those.
  const { roleOk, where } = prefilter();
  const maxAge = Date.now() - config.maxAgeDays * 86_400_000;
  // An unknown or unparseable releasedDate keeps the posting (posted_at null), as for the boards.
  const released = (j: any) => Date.parse(toIso(j.releasedDate) ?? '');
  let candidates = list.filter((j) => where(j.location?.fullLocation) && roleOk(j.name) && !(released(j) <= maxAge));
  if (candidates.length > MAX_DETAILS) {
    candidates = candidates.sort((a, b) => (released(b) || 0) - (released(a) || 0)).slice(0, MAX_DETAILS);
  }
  const out: Fetched = [];
  const failed: string[] = [];
  for (const j of candidates) {
    await sleep(DETAIL_PAUSE_MS);
    let d: any;
    try {
      d = await getJson(`${base}/${j.id}`);
    } catch (e) {
      // As for Workday: one failed detail call (e.g. a posting closed since the list) does not sink the company.
      failed.push(`${j.id}: ${(e as Error).message}`);
      continue;
    }
    out.push({
      id: `smartrecruiters:${c.token}:${j.id}`,
      source: 'smartrecruiters',
      company: c.name,
      title: j.name,
      location: j.location?.fullLocation ?? '',
      url: d.postingUrl,
      description: stripHtml(
        Object.values(d.jobAd?.sections ?? {})
          .map((s: any) => s?.text ?? '')
          .join('\n'),
      ),
      posted_at: toIso(j.releasedDate),
    });
  }
  const problems = [
    ...(listError ? [`list stopped after ${list.length} postings: ${(listError as Error).message}`] : []),
    ...(failed.length ? [`${failed.length} of ${candidates.length} details failed (first: ${failed[0]})`] : []),
  ];
  if (problems.length) {
    if (!out.length && failed.length) throw new Error(problems.join('; '));
    out.partialError = `partial: kept ${out.length} postings; ${problems.join('; ')}`;
  }
  return out;
}

/** The location text of a remote posting, as match.ts reads it ("Remote — Worldwide", "Anywhere", "Work from home"). */
const REMOTE_WORDS = /\bremote\b|anywhere|worldwide|work from home/i;

/**
 * Cheap checks on list data, so detail pages are only loaded for postings that could pass match.ts: the same title
 * rule (titleOk), and a location in a target country, Workday's "3 Locations" (which hides where the job is), or,
 * when remote jobs are on, a remote posting whose region is open to the candidate (match.ts remoteCountry: no
 * region, "not stated", or one the remote allow rule takes; "Remote — US" is dropped here as it would be there).
 */
function prefilter() {
  const countries = new RegExp(
    Object.values(config.countries)
      .map((x) => x.match)
      .join('|'),
    'i',
  );
  let allow: RegExp | null = null;
  if (config.remote.enabled) {
    const profile = loadProfile();
    allow = new RegExp(effectiveRemoteRules(config.remote, remoteFromCode(config, profile), remoteFrom(config, profile)).allow, 'i');
  }
  const remoteOk = (l: string) => {
    if (!allow || !REMOTE_WORDS.test(l)) return false;
    const region = l.replace(/\bremote\b|[—–\-(),:|/]/gi, ' ').trim();
    return !region || /not stated/i.test(region) || allow.test(region);
  };
  const where = (l = '') => countries.test(l) || /^\d+ locations$/i.test(l.trim()) || remoteOk(l);
  return { roleOk: titleOk(config), where };
}

// Workday career sites (myworkdayjobs.com) have a public JSON API ("CXS") behind every site: a POST search
// for listings and a GET per posting for the description. The token is "<tenant>/<wdN>/<site>".
const WORKDAY_PAGE = 20; // the CXS search rejects larger pages
const WORKDAY_MAX_PAGES = 25; // 500 newest postings per company

export function workdaySite(token: string) {
  const [tenant, wd, site, extra] = token.split('/');
  if (!tenant || !/^wd\d+$/.test(wd ?? '') || !site || extra !== undefined) {
    throw new Error(`workday token must be "<tenant>/<wdN>/<site>", got "${token}"`);
  }
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`;
  return { tenant, api: `${host}/wday/cxs/${tenant}/${site}`, site: `${host}/${site}` };
}

type WorkdayPosting = { title: string; externalPath: string; locationsText?: string; postedOn?: string };

/** Lists a Workday site's postings, newest first, page by page. `total` is only reliable on the first page;
 * a response without one means the total is unknown, so paging goes on until a short page or the page cap. */
export async function workdayList(token: string, maxPages = WORKDAY_MAX_PAGES): Promise<WorkdayPosting[]> {
  const { api } = workdaySite(token);
  const list: WorkdayPosting[] = [];
  let total: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await postJson(`${api}/jobs`, { limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: '', appliedFacets: {} });
    if (page === 0) total = typeof data.total === 'number' && Number.isFinite(data.total) ? data.total : null;
    const items: WorkdayPosting[] = data.jobPostings ?? [];
    list.push(...items);
    if (items.length < WORKDAY_PAGE || (total !== null && list.length >= total)) break;
    await sleep(500);
  }
  return list;
}

/** "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" / "Posted 30+ Days Ago" → days, or null. */
export function workdayAgeDays(postedOn = ''): number | null {
  if (/today/i.test(postedOn)) return 0;
  if (/yesterday/i.test(postedOn)) return 1;
  const m = postedOn.match(/(\d+)\+? days? ago/i);
  return m ? Number(m[1]) : null;
}

async function workday(c: Company): Promise<RawJob[]> {
  const { tenant, api, site } = workdaySite(c.token);
  const { roleOk, where } = prefilter();
  const fresh = (p: WorkdayPosting) => (workdayAgeDays(p.postedOn) ?? 0) <= config.maxAgeDays;
  const candidates = (await workdayList(c.token))
    .filter((p) => roleOk(p.title) && where(p.locationsText) && fresh(p))
    .slice(0, MAX_DETAILS); // the list is newest first
  const out: RawJob[] = [];
  for (const p of candidates) {
    await sleep(DETAIL_PAUSE_MS);
    let info: any;
    try {
      info = (await getJson(`${api}${p.externalPath}`)).jobPostingInfo ?? {};
    } catch (e) {
      // A posting closed between the list and the detail call should not sink the whole company.
      console.warn(`workday ${tenant}: skipped ${p.externalPath}: ${(e as Error).message}`);
      continue;
    }
    const days = workdayAgeDays(p.postedOn);
    out.push({
      id: `workday:${tenant}:${info.id ?? info.jobReqId ?? p.externalPath.split('/').pop()}`,
      source: 'workday',
      company: c.name,
      title: info.title ?? p.title,
      location: [info.location ?? p.locationsText, ...(info.additionalLocations ?? [])].filter(Boolean).join(' / '),
      url: info.externalUrl ?? `${site}${p.externalPath}`,
      description: stripHtml(info.jobDescription ?? ''),
      posted_at: toIso(info.startDate) ?? (days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString()),
    });
  }
  return out;
}

// Null-safe date helpers, shared with the boards (src/sources/boards.ts): a posting with a missing or
// unparseable date keeps a null posted_at instead of crashing the whole source.

/** Recruitee/Workable-style "2026-10-08 10:28:31 UTC", plain or ISO dates as ISO, or null. */
export const toIso = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Epoch seconds (Himalayas pubDate, Arbeitnow created_at) as milliseconds, or null when missing or not a number. */
export const epochMs = (secs: unknown): number | null => {
  const n = Number(secs);
  return Number.isFinite(n) && n > 0 ? n * 1000 : null;
};

const fetchers = { greenhouse, lever, ashby, recruitee, workable, smartrecruiters, workday };

export async function fetchCompany(c: Company): Promise<Fetched> {
  return fetchers[c.ats](c);
}
