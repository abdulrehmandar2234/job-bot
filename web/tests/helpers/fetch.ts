import { vi } from 'vitest';

type Route = (url: string, init?: RequestInit) => unknown;

/**
 * Replaces global fetch (vi.stubGlobal), with the same route map as the bot tests' mockFetch (tests/helpers.ts): each
 * route maps a URL substring to a JSON body, a string (text body) or a Response, or to a (possibly async) function
 * returning one. Unmatched URLs get a 404. Returns the recorded URLs, the vi.fn itself (for call assertions and
 * one-off behaviour such as mockRejectedValueOnce) and restore; afterEach(vi.unstubAllGlobals) restores it too.
 */
export function mockFetch(routes: Record<string, Route | unknown> = {}) {
  const calls: string[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('not found', { status: 404 });
    const r = routes[key];
    const body = typeof r === 'function' ? await (r as Route)(url, init) : r;
    if (body instanceof Response) return body;
    return typeof body === 'string' ? new Response(body) : Response.json(body);
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn, restore: () => vi.unstubAllGlobals() };
}
