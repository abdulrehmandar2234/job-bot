import { getJson, sleep } from './http.ts';
import { config } from '../config.ts';
import { decodeEntities, epochMs, partial, stripHtml, toIso, type Fetched, type RawJob } from './index.ts';
import { himalayasSearchUrl } from './open.ts';
import { structuredSalary } from '../salary.ts';
import { currencyOf } from '../currencies.ts';
import { loadProfile, remoteFromCode } from '../profile.ts';
import { COUNTRIES } from '../regions.ts';

// Remote job boards. Unlike company ATS boards these list many companies, and the location
// field says where a remote hire may live, e.g. "Remote — Worldwide" or "Remote — USA, Canada".

/** A UTC offset such as "GMT+5", "UTC-3" or "GMT+5:30" as hours, or null. */
export function utcHours(offset: string | null | undefined): number | null {
  const m = /([+−-])\s*(\d{1,2})(?::(\d{2}))?/.exec(offset ?? '');
  if (!m) return null;
  return (m[1] === '+' ? 1 : -1) * (Number(m[2]) + Number(m[3] ?? 0) / 60);
}

/**
 * The region a Himalayas job is open to, for the location field. Its time zones count too: a job "Worldwide" but
 * limited to UTC-10…-5 (the Americas) is not open to someone at GMT+5, so it reads "time zones UTC-10, UTC-9, …"
 * and the remote-region filter drops it. `home`: the candidate's UTC offset in hours (profile utcOffset); without
 * one, time zones are not checked.
 */
export function himalayasRegion(countries?: string[] | null, zones?: number[] | null, home: number | null = null): string {
  const places = countries?.length ? countries.join(', ') : '';
  if (home !== null && zones?.length && !zones.some((z) => Math.abs(z - home) <= 1)) {
    const fmt = (z: number) => `UTC${z >= 0 ? '+' : ''}${z}`;
    const span = `time zones ${[...new Set(zones)]
      .sort((a, b) => a - b)
      .map(fmt)
      .join(', ')}`;
    return places ? `${places} (${span})` : span;
  }
  return places || 'Worldwide';
}

/** The Himalayas page (its API guid) of a stored Himalayas job, from the job's id. */
export const himalayasGuid = (id: string) => `https://himalayas.app/companies/${id.replace(/^himalayas:/, '')}`;

/**
 * Where a stored Himalayas job is open to now, as its location ("Remote — United States"), or null when a search for
 * its title does not find it. A posting's restrictions can change after it was fetched (Worldwide → United States),
 * and the fetch only asks for jobs open to the candidate's country, so it never sees that change; check:open asks.
 */
export async function himalayasLocation(job: { id: string; title: string; company?: string }): Promise<string | null> {
  const guid = himalayasGuid(job.id);
  const data = await getJson(himalayasSearchUrl(job.title, job.company), { cache: false, attempts: 2 });
  const j = (data.jobs ?? []).find((x: { guid?: string }) => x.guid === guid);
  if (!j) return null;
  return `Remote — ${himalayasRegion(j.locationRestrictions, j.timezoneRestrictions, utcHours(loadProfile().utcOffset))}`;
}

/**
 * Himalayas search with country=<ISO code> only returns remote jobs open to candidates in that country: the
 * remote-from country (config remote.fromCode, else the profile's countryCode). Without one, all remote jobs.
 */
async function himalayas(): Promise<Fetched> {
  const out = new Map<string, RawJob>();
  const cutoff = Date.now() - config.maxAgeDays * 86_400_000;
  const profile = loadProfile();
  const code = remoteFromCode(config, profile);
  const country = code ? `country=${code}&` : '';
  const home = utcHours(profile.utcOffset);
  for (const q of config.remote.himalayasQueries) {
    for (let page = 1; page <= 10; page++) {
      let data: any;
      try {
        data = await getJson(`https://himalayas.app/jobs/api/search?${country}q=${encodeURIComponent(q)}&page=${page}`);
      } catch (e) {
        // Usually a 429 on a later page: stop asking, but keep the earlier pages and queries.
        return partial([...out.values()], e);
      }
      if (!data.jobs?.length) break;
      for (const j of data.jobs) {
        // A missing or non-numeric pubDate must not kill the board: the job is kept without a date.
        const posted = epochMs(j.pubDate);
        if (posted !== null && posted < cutoff) continue;
        const where = himalayasRegion(j.locationRestrictions, j.timezoneRestrictions, home);
        out.set(j.guid, {
          id: `himalayas:${j.guid.replace(/^https:\/\/himalayas\.app\/companies\//, '')}`,
          source: 'himalayas',
          company: j.companyName,
          title: j.title,
          location: `Remote — ${where}`,
          url: j.applicationLink ?? j.guid,
          description: stripHtml(j.description ?? ''),
          posted_at: posted === null ? null : new Date(posted).toISOString(),
          salary: structuredSalary(
            j.minSalary,
            j.maxSalary,
            j.currency,
            /month/i.test(j.salaryPeriod ?? '') ? 'month' : /hour/i.test(j.salaryPeriod ?? '') ? 'hour' : 'year',
          ),
        });
      }
      await sleep(400);
    }
  }
  return [...out.values()];
}

async function remotive(): Promise<RawJob[]> {
  const data = await getJson('https://remotive.com/api/remote-jobs?category=software-dev');
  return data.jobs.map((j: any) => ({
    id: `remotive:${j.id}`,
    source: 'remotive',
    company: j.company_name,
    title: j.title,
    location: `Remote — ${j.candidate_required_location || 'not stated'}`,
    url: j.url,
    description: stripHtml(j.description ?? ''),
    // publication_date is usually zoneless UTC ("2026-10-27T10:00:00"); one that is already zoned,
    // or unparseable, must not throw and kill the board.
    posted_at: j.publication_date ? (toIso(`${j.publication_date}Z`) ?? toIso(j.publication_date)) : null,
  }));
}

// Jobicy: free public API of remote jobs (https://jobicy.com/jobs-rss-feed), engineering only, 100 newest. Its terms
// ask to credit Jobicy and send applicants to the original job URL, which is what `url` is. jobGeo is where a hire
// may live ("Europe, USA", "Anywhere"), so it is the remote region, as for the other boards.
const JOBICY_PERIOD: Record<string, 'year' | 'month' | 'hour'> = { yearly: 'year', monthly: 'month', hourly: 'hour' };

async function jobicy(): Promise<RawJob[]> {
  const data = await getJson('https://jobicy.com/api/v2/remote-jobs?count=100&industry=engineering');
  return (data.jobs ?? [])
    .filter((j: any) => j.id && j.jobTitle && j.url)
    .map((j: any) => ({
      id: `jobicy:${j.id}`,
      source: 'jobicy',
      company: j.companyName ?? 'Unknown',
      title: decodeEntities(j.jobTitle),
      location: `Remote — ${(j.jobGeo ?? '').replace(/\s+/g, ' ').trim() || 'not stated'}`,
      url: j.url,
      description: stripHtml(j.jobDescription ?? j.jobExcerpt ?? ''),
      posted_at: toIso(j.pubDate),
      salary: JOBICY_PERIOD[j.salaryPeriod]
        ? structuredSalary(j.salaryMin, j.salaryMax, j.salaryCurrency, JOBICY_PERIOD[j.salaryPeriod])
        : null,
    }));
}

// Hacker News "Ask HN: Who is hiring?": a thread on the first weekday of each month by the whoishiring account, one
// top-level comment per company, through the public Algolia HN API. A comment starts with a header line of fields
// split by "|": "Company | Role | Location | REMOTE (EU) | Full-time | €70k". The role is the field that looks like a
// job title; every other field after the company goes into the location, where match.ts finds the country or the
// remote region. Postings keep their comment's date, so like any other source they age out after maxAgeDays.
const HN_ROLE = /\b(engineer|developer|programmer|architect|devops|sre|cto|lead|full.?stack|back.?end|front.?end|software)\b/i;

/** Company, title and location from a Who-is-hiring comment's header line, or null when it has no "|" fields. */
export function hnHeader(text: string): { company: string; title: string; location: string } | null {
  const first = decodeEntities(text.split(/<p>|\n/)[0].replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const fields = first
    .split('|')
    .map((f) => f.trim())
    .filter(Boolean);
  if (fields.length < 2) return null;
  // A header that runs straight into the text ("… | Full-Time We process petabytes …") ends in one long field: header
  // fields are short, so anything longer is prose and left to the description.
  const [company, ...all] = fields;
  // A link ("https://acme.com/jobs") is neither the role nor a place.
  const rest = all.filter((f) => f.length <= 80 && !/^(https?:\/\/|www\.)\S+$/i.test(f));
  if (!rest.length) return null;
  // The field that looks like a role, else the first one.
  const at = Math.max(
    0,
    rest.findIndex((f) => HN_ROLE.test(f)),
  );
  const title = rest[at];
  const location = rest.filter((_, k) => k !== at).join(' | ');
  return { company: company.slice(0, 120), title: title.slice(0, 200), location: location.slice(0, 300) };
}

async function hackernews(): Promise<RawJob[]> {
  const search = await getJson(
    'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=who%20is%20hiring&hitsPerPage=5',
  );
  const thread = (search.hits ?? []).find((h: any) => /^Ask HN: Who is hiring\?/i.test(h.title ?? ''));
  if (!thread) return [];
  const item = await getJson(`https://hn.algolia.com/api/v1/items/${thread.objectID}`);
  const out: RawJob[] = [];
  for (const c of item.children ?? []) {
    if (!c.text || !c.id) continue; // deleted or flagged comments have no text
    const h = hnHeader(c.text);
    if (!h) continue;
    out.push({
      id: `hackernews:${c.id}`,
      source: 'hackernews',
      company: h.company,
      title: h.title,
      location: h.location,
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      description: stripHtml(c.text),
      posted_at: toIso(c.created_at),
    });
  }
  return out;
}

async function remoteok(): Promise<RawJob[]> {
  const data = await getJson('https://remoteok.com/api');
  return data
    .filter((j: any) => j.id && j.position)
    .map((j: any) => ({
      id: `remoteok:${j.id}`,
      source: 'remoteok',
      company: j.company,
      title: j.position,
      location: `Remote — ${j.location || 'not stated'}`,
      url: j.url,
      description: stripHtml(`${j.description ?? ''}\n${(j.tags ?? []).join(', ')}`),
      posted_at: j.date ?? null,
      salary: structuredSalary(j.salary_min, j.salary_max, 'USD'), // yearly USD, 0 when not given
    }));
}

// Arbeitnow: free public API, mostly Germany, sorted newest first, 300 jobs per page. Its terms ask not to abuse
// it, so pages are fetched slowly and paging stops at postings older than maxAgeDays. Only Netherlands and remote
// postings are kept; match.ts then decides about the remote region as for any other board.
const ARBEITNOW_MAX_PAGES = 5;

async function arbeitnow(): Promise<Fetched> {
  const nl = new RegExp(config.countries.NL?.match ?? 'netherlands|nederland', 'i');
  const cutoff = Date.now() - config.maxAgeDays * 86_400_000;
  const out: RawJob[] = [];
  for (let page = 1; page <= ARBEITNOW_MAX_PAGES; page++) {
    let data: any;
    try {
      data = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    } catch (e) {
      return partial(out, e);
    }
    const jobs: any[] = data.data ?? [];
    for (const j of jobs) {
      // As for Himalayas: a missing or non-numeric created_at keeps the job (without a date), not the crash.
      const posted = epochMs(j.created_at);
      if ((posted !== null && posted < cutoff) || !(j.remote || nl.test(j.location ?? ''))) continue;
      out.push({
        id: `arbeitnow:${j.slug}`,
        source: 'arbeitnow',
        company: j.company_name,
        title: j.title,
        location: j.remote ? `Remote — ${j.location || 'not stated'}` : j.location,
        url: j.url,
        description: stripHtml(j.description ?? ''), // escaped HTML, which stripHtml unescapes
        posted_at: posted === null ? null : new Date(posted).toISOString(),
      });
    }
    if (!data.links?.next || !jobs.length || (epochMs(jobs.at(-1)?.created_at) ?? Number.POSITIVE_INFINITY) < cutoff) break;
    await sleep(1000);
  }
  return out;
}

// Adzuna: official API with a free app_id/app_key that the user registers for themselves (ADZUNA_APP_ID and
// ADZUNA_APP_KEY in .env). Without them the board is skipped. Adzuna has no UAE or Saudi index (its country
// list is gb, us, at, au, be, br, ca, ch, de, es, fr, in, it, mx, nl, nz, pl, sg, za); the market presets use nl and in.
// Note: the search API only returns a short snippet of each description, not the full text, so keyword scores
// and AI reviews of Adzuna jobs see less than for other sources.
const ADZUNA_PAGE = 50;
const ADZUNA_COUNTRY: Record<string, string> = { nl: 'Netherlands', in: 'India' };
async function adzuna(): Promise<Fetched> {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) return Object.assign([] as RawJob[], { skipped: 'set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env to enable it' });
  const { countries = ['nl'], keywords = config.linkedin.keywords, pagesPerSearch = 2 } = config.adzuna ?? {};
  const out = new Map<string, RawJob>();
  for (const country of countries) {
    for (const what of keywords) {
      for (let page = 1; page <= pagesPerSearch; page++) {
        const q = new URLSearchParams({
          app_id: id,
          app_key: key,
          results_per_page: String(ADZUNA_PAGE),
          what,
          max_days_old: String(config.maxAgeDays),
          'content-type': 'application/json',
        });
        let data: any;
        try {
          // No cache: the URL holds the key, and the cache file would store it on disk.
          data = await getJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${q}`, { cache: false });
        } catch (e) {
          // Errors quote the URL and end up in fetch_runs; keep the credentials out of them.
          return partial([...out.values()], new Error((e as Error).message.replaceAll(key, '***').replaceAll(id, '***')));
        }
        const results: any[] = data.results ?? [];
        for (const j of results) {
          out.set(`${country}:${j.id}`, {
            id: `adzuna:${country}:${j.id}`,
            source: 'adzuna',
            company: j.company?.display_name ?? 'Unknown',
            title: stripHtml(j.title ?? ''),
            location: [j.location?.display_name, ADZUNA_COUNTRY[country] ?? country.toUpperCase()].filter(Boolean).join(', '),
            url: j.redirect_url,
            description: stripHtml(j.description ?? ''),
            posted_at: j.created ?? null,
            // Yearly, in the country's currency (src/currencies.json). Adzuna estimates a salary when the ad has none (salary_is_predicted "1"); those are skipped.
            salary: String(j.salary_is_predicted) === '1' ? null : structuredSalary(j.salary_min, j.salary_max, currencyOf(country)),
          });
        }
        // The free plan has tight per-minute limits, so searches are spaced out.
        await sleep(2500);
        if (results.length < ADZUNA_PAGE) break;
      }
    }
  }
  return [...out.values()];
}

// freehire.me: a public, keyless search over job postings it collects from about 50 ATS and boards
// (https://freehire.me). One search per target country plus one for remote jobs open worldwide or to a region the
// remote-from country is in, engineering categories only, newest first, at most FREEHIRE_PAGES pages of 100 each.
// The agent endpoint returns the full description (the plain one cuts it to ~1,000 characters). `url` is the
// original posting on the company's ATS, so the link, the dead-link check and the extension all work on the real page.
const FREEHIRE_API = 'https://freehire.me/api/v1/agent/jobs/search';
const FREEHIRE_PAGE = 100;
export const FREEHIRE_PAGES = 5;
const FREEHIRE_CATEGORIES = ['backend', 'frontend', 'fullstack'];
// Talaash's region names (src/regions.ts) as freehire's region codes, and freehire's codes as words match.ts reads.
const FREEHIRE_REGION: Partial<Record<string, string>> = {
  apac: 'apac',
  mena: 'mena',
  europe: 'eu',
  africa: 'africa',
  northAmerica: 'north_america',
  latam: 'latam',
};
const FREEHIRE_REGION_WORDS: Record<string, string> = {
  global: 'Worldwide',
  eu: 'Europe',
  uk: 'UK',
  mena: 'Middle East',
  apac: 'APAC',
  africa: 'Africa',
  north_america: 'North America',
  latam: 'Latin America',
  cis: 'CIS',
};

/** freehire region codes for remote jobs the candidate can take: worldwide, plus the regions their country is in. */
export function freehireRegions(fromCode: string | null): string[] {
  const regions = (fromCode && COUNTRIES[fromCode]?.regions) || [];
  return ['global', ...new Set(regions.map((r) => FREEHIRE_REGION[r]).filter((r): r is string => !!r))];
}

/** A freehire job's location in the words match.ts reads: "Remote — Europe", "Arnhem, Netherlands (hybrid)". */
export function freehireLocation(j: any, countryName: (code: string) => string | undefined): string {
  const countries: string[] = (j.countries ?? []).map((c: string) => String(c).toUpperCase());
  if (j.work_mode === 'remote') {
    const where = String(j.location ?? '').trim() || (j.regions ?? []).map((r: string) => FREEHIRE_REGION_WORDS[r] ?? r).join(', ');
    return `Remote — ${where || 'not stated'}`;
  }
  const names = countries.map((c) => countryName(c) ?? c);
  const place = [...(j.cities ?? []), ...names].filter(Boolean).join(', ') || String(j.location ?? '').trim() || 'not stated';
  return j.work_mode === 'hybrid' ? `${place} (hybrid)` : place;
}

/** One freehire job as a RawJob, or null when it lacks what a posting needs or has closed. */
export function freehireJob(j: any, countryName: (code: string) => string | undefined): RawJob | null {
  if (!j?.public_slug || !j.title || !j.url || j.closed_at) return null;
  const e = j.enrichment ?? {};
  const period = ['year', 'month', 'hour'].includes(e.salary_period) ? e.salary_period : null;
  return {
    id: `freehire:${j.public_slug}`,
    source: 'freehire',
    company: String(j.company ?? '').trim() || 'Unknown',
    title: decodeEntities(String(j.title)),
    location: freehireLocation(j, countryName),
    url: j.url,
    description: String(j.description ?? ''),
    posted_at: toIso(j.posted_at),
    salary: period ? structuredSalary(e.salary_min, e.salary_max, e.salary_currency, period) : null,
  };
}

async function freehire(): Promise<Fetched> {
  const countryName = (code: string) => config.countries[code]?.name;
  const base = [
    ...FREEHIRE_CATEGORIES.map((c) => ['category', c]),
    ['posted_within_days', String(config.maxAgeDays)],
    ['description_format', 'text'],
    ['limit', String(FREEHIRE_PAGE)],
  ];
  const searches = [
    ...Object.keys(config.countries).map((code) => [['countries', code]]),
    ...(config.remote.enabled
      ? [[['work_mode', 'remote'], ...freehireRegions(remoteFromCode(config, loadProfile())).map((r) => ['regions', r])]]
      : []),
  ];
  const out = new Map<string, RawJob>();
  for (const search of searches) {
    for (let page = 0; page < FREEHIRE_PAGES; page++) {
      const q = new URLSearchParams([...search, ...base, ['offset', String(page * FREEHIRE_PAGE)]]);
      let data: any;
      try {
        data = await getJson(`${FREEHIRE_API}?${q}`);
      } catch (e) {
        return partial([...out.values()], e);
      }
      const jobs: any[] = data.data ?? [];
      for (const j of jobs) {
        const job = freehireJob(j, countryName);
        if (job) out.set(job.id, job);
      }
      await sleep(1000);
      if (jobs.length < FREEHIRE_PAGE || (page + 1) * FREEHIRE_PAGE >= (data.meta?.total ?? 0)) break;
    }
  }
  return [...out.values()];
}

export const BOARDS: Record<string, () => Promise<Fetched>> = {
  himalayas,
  remotive,
  remoteok,
  arbeitnow,
  adzuna,
  jobicy,
  hackernews,
  freehire,
};
