import { type NextRequest, NextResponse } from 'next/server';
import { FILTER_COOKIE, filtersOf, resetTarget, withSavedFilters } from '@/lib/filter-memory';
import { isLocalHost } from '@/lib/local-host';

/**
 * Refuses every request whose Host is not this machine (see lib/local-host.ts). On the job list it also keeps the
 * filters (lib/filter-memory.ts): a list URL with filters saves them, and one without gets the saved ones back. The
 * list page writes the filters into its own tab and page links, so in practice only a bare `/` is redirected.
 * `/?reset=1` forgets the saved filters and shows the list with its defaults.
 */
export function proxy(req: NextRequest) {
  if (!isLocalHost(req.headers.get('host'))) return new NextResponse('job-bot only answers on localhost', { status: 403 });
  if (req.method !== 'GET' || req.nextUrl.pathname !== '/') return NextResponse.next();
  const reset = resetTarget(req.nextUrl);
  if (reset) {
    const res = NextResponse.redirect(reset);
    res.cookies.set(FILTER_COOKIE, '', { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 0 });
    return res;
  }
  const saved = req.cookies.get(FILTER_COOKIE)?.value;
  const back = withSavedFilters(req.nextUrl, saved);
  if (back) return NextResponse.redirect(back);
  const filters = filtersOf(req.nextUrl.searchParams);
  const res = NextResponse.next();
  if (filters && filters !== saved)
    res.cookies.set(FILTER_COOKIE, filters, { path: '/', sameSite: 'lax', httpOnly: true, maxAge: 365 * 86_400 });
  return res;
}
