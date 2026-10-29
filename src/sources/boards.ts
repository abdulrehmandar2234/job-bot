import { getJson, sleep } from './http.ts';
import { config } from '../config.ts';
import { stripHtml, type RawJob } from './index.ts';
import { structuredSalary } from '../salary.ts';

// Remote job boards. Unlike company ATS boards these list many companies, and the location
// field says where a remote hire may live, e.g. "Remote — Worldwide" or "Remote — USA, Canada".

const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/** Himalayas search with country=PK only returns remote jobs open to candidates in Pakistan. */
async function himalayas(): Promise<RawJob[]> {
  const out = new Map<string, RawJob>();
  const cutoff = Date.now() - config.maxAgeDays * 86_400_000;
  for (const q of config.remote.himalayasQueries) {
    for (let page = 1; page <= 10; page++) {
      const data = await getJson(`https://himalayas.app/jobs/api/search?country=PK&q=${encodeURIComponent(q)}&page=${page}`);
      if (!data.jobs?.length) break;
      for (const j of data.jobs) {
        const posted = j.pubDate * 1000;
        if (posted < cutoff) continue;
        const where = j.locationRestrictions?.length ? j.locationRestrictions.join(', ') : 'Worldwide';
        out.set(j.guid, {
          id: `himalayas:${j.guid.replace(/^https:\/\/himalayas\.app\/companies\//, '')}`,
          source: 'himalayas',
          company: j.companyName,
          title: j.title,
          location: `Remote — ${where}`,
          url: j.applicationLink ?? j.guid,
          description: strip(j.description ?? ''),
          posted_at: new Date(posted).toISOString(),
          salary: structuredSalary(j.minSalary, j.maxSalary, j.currency,
            /month/i.test(j.salaryPeriod ?? '') ? 'month' : /hour/i.test(j.salaryPeriod ?? '') ? 'hour' : 'year'),
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
    description: strip(j.description ?? ''),
    posted_at: j.publication_date ? new Date(`${j.publication_date}Z`).toISOString() : null,
  }));
}

async function remoteok(): Promise<RawJob[]> {
  const data = await getJson('https://remoteok.com/api');
  return data.filter((j: any) => j.id && j.position).map((j: any) => ({
    id: `remoteok:${j.id}`,
    source: 'remoteok',
    company: j.company,
    title: j.position,
    location: `Remote — ${j.location || 'not stated'}`,
    url: j.url,
    description: strip(`${j.description ?? ''}\n${(j.tags ?? []).join(', ')}`),
    posted_at: j.date ?? null,
    salary: structuredSalary(j.salary_min, j.salary_max, 'USD'), // yearly USD, 0 when not given
  }));
}

// Arbeitnow: free public API, mostly Germany, sorted newest first, 300 jobs per page. Its terms ask not to abuse
// it, so pages are fetched slowly and paging stops at postings older than maxAgeDays. Only Netherlands and remote
// postings are kept; match.ts then decides about the remote region as for any other board.
const ARBEITNOW_MAX_PAGES = 5;

async function arbeitnow(): Promise<RawJob[]> {
  const nl = new RegExp(config.countries.NL?.match ?? 'netherlands|nederland', 'i');
  const cutoff = Date.now() - config.maxAgeDays * 86_400_000;
  const out: RawJob[] = [];
  for (let page = 1; page <= ARBEITNOW_MAX_PAGES; page++) {
    const data = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
    const jobs: any[] = data.data ?? [];
    for (const j of jobs) {
      const posted = j.created_at * 1000;
      if (posted < cutoff || !(j.remote || nl.test(j.location ?? ''))) continue;
      out.push({
        id: `arbeitnow:${j.slug}`,
        source: 'arbeitnow',
        company: j.company_name,
        title: j.title,
        location: j.remote ? `Remote — ${j.location || 'not stated'}` : j.location,
        url: j.url,
        description: stripHtml(j.description ?? ''), // escaped HTML, which stripHtml decodes
        posted_at: new Date(posted).toISOString(),
      });
    }
    if (!data.links?.next || !jobs.length || jobs.at(-1).created_at * 1000 < cutoff) break;
    await sleep(1000);
  }
  return out;
}

// Adzuna: official API with a free app_id/app_key that the user registers for himself (ADZUNA_APP_ID and
// ADZUNA_APP_KEY in .env). Without them the board is skipped. Adzuna has no UAE or Saudi index (its country
// list is gb, us, at, au, be, br, ca, ch, de, es, fr, in, it, mx, nl, nz, pl, sg, za), so only 'nl' is useful here.
// Note: the search API only returns a short snippet of each description, not the full text, so keyword scores
// and AI reviews of Adzuna jobs see less than for other sources.
const ADZUNA_PAGE = 50;
const ADZUNA_COUNTRY: Record<string, string> = { nl: 'Netherlands' };
const ADZUNA_CURRENCY: Record<string, string> = { nl: 'EUR', de: 'EUR', at: 'EUR', be: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', gb: 'GBP', us: 'USD' };

async function adzuna(): Promise<RawJob[]> {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!id || !key) {
    console.log('adzuna: skipped (set ADZUNA_APP_ID and ADZUNA_APP_KEY in .env to enable it)');
    return [];
  }
  const { countries = ['nl'], keywords = config.linkedin.keywords, pagesPerSearch = 2 } = config.adzuna ?? {};
  const out = new Map<string, RawJob>();
  for (const country of countries) {
    for (const what of keywords) {
      for (let page = 1; page <= pagesPerSearch; page++) {
        const q = new URLSearchParams({ app_id: id, app_key: key, results_per_page: String(ADZUNA_PAGE), what,
          max_days_old: String(config.maxAgeDays), 'content-type': 'application/json' });
        let data: any;
        try {
          // No cache: the URL holds the key, and the cache file would store it on disk.
          data = await getJson(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}?${q}`, { cache: false });
        } catch (e) {
          // Errors quote the URL and end up in fetch_runs; keep the credentials out of them.
          throw new Error((e as Error).message.replaceAll(key, '***').replaceAll(id, '***'));
        }
        const results: any[] = data.results ?? [];
        for (const j of results) {
          out.set(`${country}:${j.id}`, {
            id: `adzuna:${country}:${j.id}`,
            source: 'adzuna',
            company: j.company?.display_name ?? 'Unknown',
            title: strip(j.title ?? ''),
            location: [j.location?.display_name, ADZUNA_COUNTRY[country] ?? country.toUpperCase()].filter(Boolean).join(', '),
            url: j.redirect_url,
            description: strip(j.description ?? ''),
            posted_at: j.created ?? null,
            // Yearly. Adzuna estimates a salary when the ad has none (salary_is_predicted "1"); those are skipped.
            salary: String(j.salary_is_predicted) === '1' ? null
              : structuredSalary(j.salary_min, j.salary_max, ADZUNA_CURRENCY[country]),
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

export const BOARDS: Record<string, () => Promise<RawJob[]>> = { himalayas, remotive, remoteok, arbeitnow, adzuna };
