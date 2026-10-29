import { readFileSync, writeFileSync } from 'node:fs';
import { getJson, sleep } from './sources/http.ts';
import { ATS, config, path, type Company } from './config.ts';

// Finds which public job board (ATS) a company uses and how many of its jobs are in target countries.
// Only list endpoints are called, so this stays cheap.

type Hit = { slug: string; ats: Company['ats']; jobs: number; target: number };

const locations: Record<Company['ats'], (slug: string) => Promise<string[] | null>> = {
  greenhouse: async (t) => (await json(`https://boards-api.greenhouse.io/v1/boards/${t}/jobs`))?.jobs?.map((x: any) => x.location?.name ?? ''),
  lever: async (t) => {
    const d = await json(`https://api.lever.co/v0/postings/${t}?mode=json`);
    return Array.isArray(d) ? d.map((x: any) => [x.categories?.location, ...(x.categories?.allLocations ?? [])].join(' ')) : null;
  },
  ashby: async (t) => (await json(`https://api.ashbyhq.com/posting-api/job-board/${t}`))?.jobs
    ?.map((x: any) => [x.location, ...(x.secondaryLocations ?? []).map((l: any) => l.location)].join(' ')),
  recruitee: async (t) => (await json(`https://${t}.recruitee.com/api/offers/`))?.offers?.map((x: any) => `${x.location} ${x.country}`),
  workable: async (t) => (await json(`https://apply.workable.com/api/v1/widget/accounts/${t}`))?.jobs
    ?.map((x: any) => [x.city, x.country, ...(x.locations ?? []).map((l: any) => `${l.city} ${l.country}`)].join(' ')),
  smartrecruiters: async (t) => (await json(`https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`))?.content
    ?.map((x: any) => x.location?.fullLocation ?? ''),
};

// Most probes hit boards that do not exist; a 404 (or any other 4xx but 429) returns null at once, without retries.
async function json(url: string) {
  try {
    return await getJson(url, { timeoutMs: 15_000, attempts: 3 });
  } catch {
    return null;
  }
}

export async function discover(slugs: string[]): Promise<Hit[]> {
  const target = new RegExp(Object.values(config.countries).map((c) => c.match).join('|'), 'i');
  const hits: Hit[] = [];
  // Workable rate-limits aggressively, so it is probed one slug at a time in its own lane.
  const fast = slugs.flatMap((s) => ATS.filter((a) => a !== 'workable').map((a) => [s, a] as const));
  const slow = slugs.map((s) => [s, 'workable'] as const);
  const probe = async (queue: (readonly [string, Company['ats']])[], delay: number) => {
    while (queue.length) {
      const [slug, ats] = queue.shift()!;
      const locs = await locations[ats](slug);
      if (locs?.length) hits.push({ slug, ats, jobs: locs.length, target: locs.filter((l) => target.test(l)).length });
      if (delay) await sleep(delay);
    }
  };
  await Promise.all([...Array.from({ length: 8 }, () => probe(fast, 0)), probe(slow, 2500)]);
  return hits.sort((a, b) => b.target - a.target);
}

/** Appends boards with target-country jobs to config.json (skips ones already there). */
export function addToConfig(hits: Hit[]) {
  const file = path('config.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const known = new Set(raw.companies.map((c: Company) => `${c.ats}:${c.token}`));
  const added: Company[] = [];
  for (const h of hits) {
    if (!h.target || known.has(`${h.ats}:${h.slug}`)) continue;
    const name = h.slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
    added.push({ name, ats: h.ats, token: h.slug });
    known.add(`${h.ats}:${h.slug}`);
  }
  raw.companies.push(...added);
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
  return added;
}
