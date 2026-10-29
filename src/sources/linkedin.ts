import { HttpError, getText, sleep } from './http.ts';
import { config } from '../config.ts';
import type { RawJob } from './index.ts';

// LinkedIn public ("guest") job search — the same endpoints linkedin.com/jobs uses when logged out.
// No account is involved. Requests are paced so a daily run stays small.

const BASE = 'https://www.linkedin.com/jobs-guest/jobs/api';
export const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const strip = (html: string) => decode(html.replace(/<\/(p|li|h\d|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
  .replace(/ ?\n ?/g, '\n');

// A 429 from LinkedIn means the guest endpoints are throttling this IP: stop LinkedIn for today
// (no retries, which would only prolong the block). Network errors and 5xx are still retried.
async function get(url: string) {
  try {
    return await getText(url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, retryOn: (s) => s >= 500 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) throw new Error(`429 LinkedIn rate limit: stopping LinkedIn for today (${url})`);
    throw e;
  }
}

type Card = { id: string; title: string; company: string; location: string; date: string | null };

function parseCards(html: string): Card[] {
  return html.split('<li').slice(1).flatMap((li) => {
    const id = li.match(/urn:li:jobPosting:(\d+)/)?.[1];
    const title = li.match(/base-search-card__title[^>]*>([\s\S]*?)<\//)?.[1];
    if (!id || !title) return [];
    return [{
      id,
      title: decode(title),
      company: decode((li.match(/base-search-card__subtitle[^>]*>([\s\S]*?)<\/h4>/)?.[1] ?? '').replace(/<[^>]+>/g, '')),
      location: decode(li.match(/job-search-card__location[^>]*>([\s\S]*?)<\//)?.[1] ?? ''),
      date: li.match(/datetime="(\d{4}-\d{2}-\d{2})"/)?.[1] ?? null,
    }];
  });
}

export async function linkedin(): Promise<RawJob[]> {
  const li = config.linkedin;
  const days = config.maxAgeDays;
  const include = new RegExp(config.roleInclude, 'i');
  const exclude = new RegExp(config.roleExclude, 'i');
  // Onsite searches per country, plus remote searches located in the candidate's own country.
  const searches = [
    ...li.locations.map((location) => ({ location, remote: false })),
    ...(config.remote.enabled && li.remoteFrom ? [{ location: li.remoteFrom, remote: true }] : []),
  ];

  const cards = new Map<string, Card & { remote: boolean }>();
  for (const s of searches) {
    for (const keywords of li.keywords) {
      for (let start = 0; start < li.pagesPerSearch * 10; start += 10) {
        const q = new URLSearchParams({ keywords, location: s.location, f_TPR: `r${days * 86400}`, start: String(start) });
        if (s.remote) q.set('f_WT', '2');
        const page = parseCards(await get(`${BASE}/seeMoreJobPostings/search?${q}`));
        for (const c of page) if (!cards.has(c.id)) cards.set(c.id, { ...c, remote: s.remote });
        await sleep(1200);
        if (page.length < 10) break;
      }
    }
  }

  const out: RawJob[] = [];
  for (const c of cards.values()) {
    // Same title rules as scoring, applied before the (slower) detail request.
    if (!include.test(c.title) || exclude.test(c.title)) continue;
    const html = await get(`${BASE}/jobPosting/${c.id}`);
    const markup = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*<button/)?.[1]
      ?? html.match(/description__text[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
    out.push({
      id: `linkedin:${c.id}`,
      source: 'linkedin',
      company: c.company || 'Unknown',
      title: c.title,
      location: c.remote ? `Remote — ${c.location || li.remoteFrom}` : c.location,
      url: `https://www.linkedin.com/jobs/view/${c.id}/`,
      description: strip(markup),
      posted_at: c.date ? new Date(`${c.date}T00:00:00Z`).toISOString() : null,
    });
    await sleep(1200);
  }
  return out;
}
