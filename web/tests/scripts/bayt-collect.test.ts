// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

// job-bot/scripts/bayt-collect.js, the collector the bookmarklet loads into a bayt.com tab.
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'scripts', 'bayt-collect.js'), 'utf8');
const ORIGIN = 'https://www.bayt.com';
const IMPORT_URL = 'http://localhost:3100/api/import';
const SEARCHES = 2 * 9; // countries x keywords

type BaytJob = {
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  posted_at: string | null;
};
type BaytState = { phase: string; links: string[]; jobs: BaytJob[]; done: boolean; errors: string[]; result?: unknown };
type FakeResponse = { ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> };
type Route = FakeResponse | (() => never);

const state = () => (window as unknown as { __bayt?: BaytState }).__bayt;
const box = () => document.body.lastElementChild as HTMLElement;

const respond = (body: string | object, status = 200): FakeResponse => ({
  ok: status < 400,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});
const listing = (...hrefs: string[]) => respond(`<html><body>${hrefs.map((h) => `<a href="${h}">job</a>`).join('')}</body></html>`);
const ldJson = (...blocks: string[]) =>
  respond(`<html><head>${blocks.map((b) => `<script type="application/ld+json">${b}</script>`).join('')}</head><body></body></html>`);
const posting = (jp: object) => JSON.stringify({ '@type': 'JobPosting', ...jp });
const fail = (msg: string) => () => {
  throw new TypeError(msg);
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

/**
 * A fake bayt.com plus dashboard. Listing pages are keyed `country/keyword/page`, job pages by path;
 * anything not listed is an empty listing page. Records each call with the progress box text at that moment.
 */
function fakeSite(listings: Record<string, Route>, jobs: Record<string, Route>, importRoute: Route = respond({ received: 0, matched: 0 })) {
  const calls: { url: string; init?: RequestInit; box: string }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init, box: box().innerHTML });
    const m = url.match(/^\/en\/([a-z-]+)\/jobs\/([a-z-]+)-jobs\/(?:\?page=(\d+))?$/);
    const route =
      url === IMPORT_URL
        ? importRoute
        : m
          ? (listings[`${m[1]}/${m[2]}/${m[3] ?? 1}`] ?? listing())
          : (jobs[url] ?? respond('not found', 404));
    return typeof route === 'function' ? route() : route;
  });
  return { fetch, calls };
}

/** Runs the collector like the bookmarklet would and returns what the script itself returns. */
function runCollector(fetch: (url: string, init?: RequestInit) => Promise<FakeResponse>) {
  return new Function('window', 'document', 'fetch', 'location', 'src', 'return eval(src)')(
    window,
    document,
    fetch,
    { origin: ORIGIN },
    SOURCE,
  ) as string;
}

const finished = () => vi.waitFor(() => expect(state()?.done).toBe(true), { timeout: 5000 });

afterEach(() => {
  delete (window as unknown as { __bayt?: BaytState }).__bayt;
  document.body.innerHTML = '';
});

describe('bayt-collect.js', () => {
  it('collects fresh developer jobs from the search pages and posts them to the dashboard', async () => {
    const sales = Array.from({ length: 13 }, (_, i) => `/en/uae/jobs/sales-manager-20000${10 + i}/`);
    const { fetch, calls } = fakeSite(
      {
        // 15 job links on page 1, so page 2 is read too; the pager and other countries' links are ignored.
        'uae/laravel/1': listing(
          '/en/uae/jobs/senior-laravel-developer-1000001/',
          '/en/uae/jobs/node-js-engineer-1000002/',
          ...sales,
          '/en/uae/jobs/laravel-jobs/?page=2',
          '/en/saudi-arabia/jobs/web-developer-1000099/',
        ),
        'uae/laravel/2': listing('/en/uae/jobs/php-developer-1000003/', '/en/uae/jobs/senior-laravel-developer-1000001/'),
        'uae/php-developer/1': respond('blocked', 403),
        'uae/node-js/1': fail('Failed to fetch'),
        'saudi-arabia/react-js/1': listing(
          '/en/saudi-arabia/jobs/full-stack-developer-1000004/',
          '/en/saudi-arabia/jobs/react-native-developer-1000005/',
          '/en/saudi-arabia/jobs/frontend-developer-1000006/',
          '/en/saudi-arabia/jobs/web-developer-1000007/',
        ),
      },
      {
        '/en/uae/jobs/senior-laravel-developer-1000001/': ldJson(
          posting({
            title: 'Senior Laravel Developer',
            hiringOrganization: { name: 'Acme' },
            datePosted: daysAgo(2),
            description: '<p>Build <b>APIs</b></p> ',
            jobLocation: [
              { address: { addressLocality: 'Dubai', addressCountry: 'AE' } },
              { address: { addressLocality: 'Abu Dhabi', addressCountry: 'AE' } },
            ],
          }),
        ),
        '/en/uae/jobs/node-js-engineer-1000002/': ldJson(
          posting({
            title: 'Node.js Engineer',
            jobLocation: { address: { addressLocality: 'Doha', addressCountry: 'QA' } },
          }),
        ),
        '/en/uae/jobs/php-developer-1000003/': ldJson(posting({ title: 'Old PHP job', datePosted: daysAgo(20), jobLocation: [] })),
        '/en/saudi-arabia/jobs/full-stack-developer-1000004/': ldJson(
          '{not json',
          JSON.stringify([
            { '@type': 'Organization' },
            {
              '@type': 'JobPosting',
              title: 'Full Stack Developer',
              hiringOrganization: { name: 'Globex' },
              datePosted: daysAgo(1),
              jobLocation: { address: { addressLocality: 'Riyadh', addressCountry: 'SA' } },
            },
          ]),
        ),
        '/en/saudi-arabia/jobs/frontend-developer-1000006/': ldJson(JSON.stringify({ '@type': 'Organization', name: 'No posting here' })),
        '/en/saudi-arabia/jobs/web-developer-1000007/': fail('Bayt timeout'),
      },
      respond({ received: 3, matched: 2 }),
    );

    expect(runCollector(fetch)).toBe('started');
    expect(box()).toHaveTextContent('Job Bot · Bayt');
    await finished();
    const S = state()!;

    // Search: every country x keyword, page 2 only after a full page, nothing more after a 403.
    const searched = calls.filter((c) => c.url.startsWith('/en/') && c.url.includes('-jobs/')).map((c) => c.url);
    expect(searched).toContain('/en/uae/jobs/laravel-jobs/?page=2');
    expect(searched).not.toContain('/en/uae/jobs/php-developer-jobs/?page=2');
    expect(searched).not.toContain('/en/uae/jobs/vue-js-jobs/?page=2');
    expect(new Set(searched.filter((u) => !u.includes('?page='))).size).toBe(SEARCHES);

    // Non-developer slugs (sales manager, React Native) are dropped before their pages are loaded.
    expect(S.links).toEqual([
      '/en/uae/jobs/senior-laravel-developer-1000001/',
      '/en/uae/jobs/node-js-engineer-1000002/',
      '/en/uae/jobs/php-developer-1000003/',
      '/en/saudi-arabia/jobs/full-stack-developer-1000004/',
      '/en/saudi-arabia/jobs/frontend-developer-1000006/',
      '/en/saudi-arabia/jobs/web-developer-1000007/',
    ]);
    expect(calls.some((c) => /sales-manager|react-native/.test(c.url))).toBe(false);

    // Old postings and pages without a JobPosting are skipped.
    const jobs = [...S.jobs].sort((a, b) => a.url.localeCompare(b.url));
    expect(jobs).toEqual([
      {
        source: 'bayt',
        company: 'Globex',
        title: 'Full Stack Developer',
        location: 'Riyadh, Saudi Arabia',
        url: `${ORIGIN}/en/saudi-arabia/jobs/full-stack-developer-1000004/`,
        description: '',
        posted_at: expect.any(String),
      },
      {
        source: 'bayt',
        company: 'Unknown',
        title: 'Node.js Engineer',
        location: 'Doha, QA',
        url: `${ORIGIN}/en/uae/jobs/node-js-engineer-1000002/`,
        description: '',
        posted_at: null,
      },
      {
        source: 'bayt',
        company: 'Acme',
        title: 'Senior Laravel Developer',
        location: 'Dubai, UAE / Abu Dhabi, UAE',
        url: `${ORIGIN}/en/uae/jobs/senior-laravel-developer-1000001/`,
        description: 'Build APIs',
        posted_at: expect.any(String),
      },
    ]);

    expect(S.errors).toEqual(['403 uae/php-developer', 'TypeError: Failed to fetch', 'TypeError: Bayt timeout']);

    // One POST with every collected job.
    const imports = calls.filter((c) => c.url === IMPORT_URL);
    expect(imports).toHaveLength(1);
    expect(imports[0].init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } });
    expect(JSON.parse(imports[0].init!.body as string)).toEqual(S.jobs);
    expect(S.phase).toBe('import');
    expect(S.result).toEqual({ received: 3, matched: 2 });
  });

  it('reports progress in the corner box', async () => {
    const { fetch, calls } = fakeSite(
      {
        'uae/laravel/1': listing('/en/uae/jobs/laravel-developer-1000001/', '/en/uae/jobs/php-developer-1000002/'),
      },
      {
        '/en/uae/jobs/laravel-developer-1000001/': ldJson(posting({ title: 'Laravel Developer', jobLocation: [] })),
        '/en/uae/jobs/php-developer-1000002/': ldJson(posting({ title: 'PHP Developer', jobLocation: [] })),
      },
      respond({ received: 2, matched: 1 }),
    );
    runCollector(fetch);
    // Record every later update of the box (messages replace each other within one tick).
    const shown: string[] = [];
    const inner = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    Object.defineProperty(box(), 'innerHTML', {
      get() {
        return inner.get!.call(this);
      },
      set(html: string) {
        shown.push(html.replace('<b>Job Bot · Bayt</b><br>', ''));
        inner.set!.call(this, html);
      },
    });
    await finished();

    expect(box().style.position).toBe('fixed');
    const at = (url: string) => calls.find((c) => c.url === url)!.box;
    expect(at('/en/uae/jobs/laravel-jobs/')).toContain(`Searching uae · laravel (1/${SEARCHES})<br>0 jobs found so far`);
    expect(shown).toContain(`Searching uae · php-developer (2/${SEARCHES})<br>2 jobs found so far`);
    expect(shown).toContain(
      'Reading job pages 1/2 (Bayt is slow, ~20s each)<br>1 fresh developer jobs<br><small>Keep this tab open.</small>',
    );
    expect(shown).toContain(
      'Reading job pages 2/2 (Bayt is slow, ~20s each)<br>2 fresh developer jobs<br><small>Keep this tab open.</small>',
    );
    expect(at(IMPORT_URL)).toContain('Sending 2 jobs to the dashboard…');

    expect(box()).toHaveTextContent('Done ✓ 2 sent, 1 matched your profile.');
    expect(box().querySelector('a')).toHaveAttribute('href', 'http://localhost:3100');
  });

  it('says so when the dashboard cannot be reached', async () => {
    const { fetch } = fakeSite({}, {}, fail('Failed to fetch'));
    runCollector(fetch);
    await finished();
    expect(state()!.jobs).toEqual([]);
    expect(state()!.errors).toEqual(['import: TypeError: Failed to fetch']);
    expect(state()!.result).toBeUndefined();
    expect(box()).toHaveTextContent('Could not reach the dashboard. Is npm run web running, and did you allow local network access?');
  });

  it('does not start a second run while one is going, but can run again once done', async () => {
    (window as unknown as { __bayt: Partial<BaytState> }).__bayt = { done: false };
    const busy = fakeSite({}, {});
    expect(runCollector(busy.fetch)).toBe('already running');
    expect(busy.fetch).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);

    (window as unknown as { __bayt: Partial<BaytState> }).__bayt = { done: true };
    const again = fakeSite({}, {});
    expect(runCollector(again.fetch)).toBe('started');
    await finished();
    expect(again.fetch).toHaveBeenCalledWith(IMPORT_URL, expect.anything());
  });
});
