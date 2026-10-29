import { getJson, sleep } from './http.ts';
import { config, type Company } from '../config.ts';

export type RawJob = {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  posted_at: string | null;
};

const stripHtml = (html: string) =>
  html
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/<\/(p|li|h\d|div|br)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
    // Escaped HTML (Greenhouse) leaves a second layer of entities inside the text.
    .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n\s*\n+/g, '\n').trim();

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
      .filter(Boolean).join('\n'),
    posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
  }));
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
      .filter(Boolean).join(' / '),
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
  const data = await getJson(`https://apply.workable.com/api/v1/widget/accounts/${c.token}?details=true`,
    { baseDelayMs: 15_000, retryOn: (s) => s === 429 || s === 403 || s >= 500 });
  return data.jobs.map((j: any) => ({
    id: `workable:${c.token}:${j.shortcode}`,
    source: 'workable',
    company: c.name,
    title: j.title,
    location: [[j.city, j.country].filter(Boolean).join(', '),
      ...(j.locations ?? []).map((l: any) => [l.city, l.country].filter(Boolean).join(', '))]
      .filter(Boolean).join(' / '),
    url: j.url ?? j.shortlink ?? `https://apply.workable.com/${c.token}/j/${j.shortcode}/`,
    description: stripHtml(j.description ?? ''),
    posted_at: toIso(j.published_on ?? j.created_at),
  }));
}

// The list endpoint has no descriptions, so details are fetched only for postings that could pass the filters.
async function smartrecruiters(c: Company): Promise<RawJob[]> {
  const base = `https://api.smartrecruiters.com/v1/companies/${c.token}/postings`;
  const list: any[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await getJson(`${base}?limit=100&offset=${offset}`);
    list.push(...page.content);
    if (offset + 100 >= page.totalFound || offset >= 1000) break;
  }
  const countries = new RegExp(Object.values(config.countries).map((x) => x.match).join('|'), 'i');
  const include = new RegExp(config.roleInclude, 'i');
  const exclude = new RegExp(config.roleExclude, 'i');
  const maxAge = Date.now() - config.maxAgeDays * 86_400_000;
  const candidates = list.filter((j) => countries.test(j.location?.fullLocation ?? '') && include.test(j.name)
    && !exclude.test(j.name) && new Date(j.releasedDate).getTime() > maxAge);
  const out: RawJob[] = [];
  for (const j of candidates) {
    const d = await getJson(`${base}/${j.id}`);
    out.push({
      id: `smartrecruiters:${c.token}:${j.id}`,
      source: 'smartrecruiters',
      company: c.name,
      title: j.name,
      location: j.location?.fullLocation ?? '',
      url: d.postingUrl,
      description: stripHtml(Object.values(d.jobAd?.sections ?? {}).map((s: any) => s?.text ?? '').join('\n')),
      posted_at: j.releasedDate ?? null,
    });
  }
  return out;
}

// Recruitee/Workable send "2026-10-08 10:28:31 UTC" or plain dates.
const toIso = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s.replace(' UTC', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const fetchers = { greenhouse, lever, ashby, recruitee, workable, smartrecruiters };

export async function fetchCompany(c: Company): Promise<RawJob[]> {
  return fetchers[c.ats](c);
}
