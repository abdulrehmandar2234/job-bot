import { sleep } from './http.ts';
import { config } from '../config.ts';
import type { RawJob } from './index.ts';

// Remote job boards. Unlike company ATS boards these list many companies, and the location
// field says where a remote hire may live, e.g. "Remote — Worldwide" or "Remote — USA, Canada".

const UA = 'job-bot/0.1 (personal job search)';
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

async function getJson(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

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
  }));
}

export const BOARDS: Record<string, () => Promise<RawJob[]>> = { himalayas, remotive, remoteok };
