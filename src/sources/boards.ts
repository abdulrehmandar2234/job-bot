import { getJson, sleep } from './http.ts';
import { config } from '../config.ts';
import { epochMs, partial, stripHtml, toIso, type Fetched, type RawJob } from './index.ts';
import { himalayasSearchUrl } from './open.ts';
import { structuredSalary } from '../salary.ts';
import { currencyOf } from '../currencies.ts';
import { loadProfile, remoteFromCode } from '../profile.ts';

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

export const BOARDS: Record<string, () => Promise<Fetched>> = { himalayas, remotive, remoteok, arbeitnow, adzuna };
