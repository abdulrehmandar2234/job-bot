import { parsePayRange } from '../salary.ts';
import { HttpError, getText, sleep } from './http.ts';
import { config } from '../config.ts';
import { titleOk } from '../match.ts';
import { decodeEntities, partial, stripHtml, type Fetched, type RawJob } from './index.ts';

// LinkedIn public ("guest") job search — the same endpoints linkedin.com/jobs uses when logged out.
// No account is involved. Requests are paced so a daily run stays small.

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** A card field (title, company, location): entities decoded, whitespace collapsed to one line. */
const decode = (s: string) => decodeEntities(s).replace(/\s+/g, ' ').trim();

// A 429 from LinkedIn means the guest endpoints are throttling this IP: stop LinkedIn for today
// (no retries, which would only prolong the block). Network errors and 5xx are still retried.
class RateLimited extends Error {}

async function get(url: string) {
  try {
    return await getText(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, retryOn: (s) => s >= 500 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw new RateLimited(`429 LinkedIn rate limit: stopping LinkedIn for today (${url})`);
    throw e;
  }
}

/**
 * LinkedIn's job criteria box ("Seniority level: Mid-Senior level", "Employment type: Full-time") as lines appended to
 * the description, where src/match.ts reads the job type. Industries and job function are left out.
 */
export function criteriaLines(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*job-criteria-text[^>]*>([\s\S]*?)<\/span>/g)) {
    const name = decode(m[1].replace(/<[^>]+>/g, ''));
    const value = decode(m[2].replace(/<[^>]+>/g, ''));
    if (value && /^(seniority level|employment type)$/i.test(name)) out.push(`${name}: ${value}`);
  }
  return out;
}

type Card = { id: string; title: string; company: string; location: string; date: string | null };

function parseCards(html: string): Card[] {
  return html
    .split('<li')
    .slice(1)
    .flatMap((li) => {
      const id = li.match(/urn:li:jobPosting:(\d+)/)?.[1];
      const title = li.match(/base-search-card__title[^>]*>([\s\S]*?)<\//)?.[1];
      if (!id || !title) return [];
      return [
        {
          id,
          title: decode(title),
          company: decode((li.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? '').replace(/<[^>]+>/g, '')),
          location: decode(li.match(/job-search-card__location[^>]*>([\s\S]*?)<\//)?.[1] ?? ''),
          date: li.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null,
        },
      ];
    });
}

export async function linkedin(): Promise<Fetched> {
  const li = config.linkedin;
  const days = config.maxAgeDays;
  const roleOk = titleOk(config);
  // Onsite searches per country, plus remote searches located in the candidate's own country.
  const searches = [
    ...li.locations.map((location) => ({ location, remote: false })),
    ...(config.remote.enabled && li.remoteFrom ? [{ location: li.remoteFrom, remote: true }] : []),
  ];

  const cards = new Map<string, Card & { remote: boolean }>();
  let searchError: Error | undefined;
  const unparsed: string[] = [];
  search: for (const s of searches) {
    for (const keywords of li.keywords) {
      for (let start = 0; start < li.pagesPerSearch * 10; start += 10) {
        const q = new URLSearchParams({ keywords, location: s.location, f_TPR: `r${days * 86400}`, start: String(start) });
        if (s.remote) q.set('f_WT', '2');
        let html: string;
        try {
          html = await get(`${BASE}/seeMoreJobPostings/search?${q}`);
        } catch (e) {
          // Stop searching. A search page that kept failing (404, 5xx after retries) keeps the cards already
          // collected and goes on to their details, as a partial result; a 429 stops LinkedIn at once (below).
          searchError = e as Error;
          break search;
        }
        const page = parseCards(html);
        // List markup in which no card parses means LinkedIn changed its card markup: record it, otherwise the
        // breakage would look like a quiet "0 postings" success. A page with no list items is just no results.
        if (!page.length && /<li[\s>]/i.test(html)) unparsed.push(`"${keywords}" in ${s.location}`);
        for (const c of page) if (!cards.has(c.id)) cards.set(c.id, { ...c, remote: s.remote });
        await sleep(1200);
        if (page.length < 10) break;
      }
    }
  }

  const out: RawJob[] = [];
  const failed: string[] = [];
  // A 429 stops LinkedIn for this fetch: no detail requests after it, or the site would block the bot.
  if (searchError instanceof RateLimited) return partial(out, searchError);
  for (const c of cards.values()) {
    // Same title rules as scoring, applied before the (slower) detail request.
    if (!roleOk(c.title)) continue;
    let html: string;
    try {
      html = await get(`${BASE}/jobPosting/${c.id}`);
    } catch (e) {
      // A 429 still stops LinkedIn for today, but the details fetched so far are kept.
      if (e instanceof RateLimited) return partial(out, e);
      failed.push(`${c.id}: ${(e as Error).message}`);
      continue;
    }
    const markup =
      html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*<button/)?.[1] ??
      html.match(/description__text[^>]*>([\s\S]*?)<\/section>/)?.[1] ??
      '';
    // The pay range the company entered sits in its own box ("Base pay range"), not in the description.
    // Its wrapper is "compensation__salary-range"; the amount is in the element whose class ends in "compensation__salary".
    const pay = html.match(/compensation__salary"[^>]*>([^<]+)</)?.[1];
    out.push({
      id: `linkedin:${c.id}`,
      source: 'linkedin',
      company: c.company || 'Unknown',
      title: c.title,
      location: c.remote ? `Remote — ${c.location || li.remoteFrom}` : c.location,
      url: `https://www.linkedin.com/jobs/view/${c.id}/`,
      description: [stripHtml(markup), ...criteriaLines(html)].filter(Boolean).join('\n'),
      posted_at: c.date ? new Date(`${c.date}T00:00:00Z`).toISOString() : null,
      salary: parsePayRange(pay),
    });
    await sleep(1200);
  }
  const problems = [
    ...(searchError ? [`search stopped: ${searchError.message}`] : []),
    ...(unparsed.length ? [`${unparsed.length} searches had pages with no parsable cards (markup change? first: ${unparsed[0]})`] : []),
    ...(failed.length ? [`${failed.length} details failed (first: ${failed[0]})`] : []),
  ];
  if (problems.length) return partial(out, new Error(problems.join('; ')));
  return out;
}
