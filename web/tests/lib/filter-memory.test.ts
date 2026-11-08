import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_DAYS, FILTER_COOKIE, filtersOf, postedDays, withSavedFilters } from '@/lib/filter-memory';
import { proxy } from '@/proxy';

// The job list keeps its filters until they are changed: proxy.ts saves them in a cookie and puts them back.

describe('postedDays', () => {
  it('is the last 24 hours when the URL does not say, and any time for 0 or empty', () => {
    expect(DEFAULT_DAYS).toBe(1);
    expect(postedDays(undefined)).toBe(1);
    expect(postedDays('3')).toBe(3);
    for (const raw of ['0', '', 'abc', '-2']) expect(postedDays(raw)).toBeUndefined();
  });
});

describe('filtersOf', () => {
  it('keeps the remembered filters, empty ones included, and drops tab, search and page', () => {
    expect(filtersOf(new URLSearchParams('status=applied&q=php&page=2&country=&days=0&size=25&visa=1'))).toBe(
      'country=&days=0&size=25&visa=1',
    );
    expect(filtersOf(new URLSearchParams('status=applied&q=php&page=2'))).toBeNull();
  });
});

describe('withSavedFilters', () => {
  const url = (q: string) => new URL(`http://localhost:3100/?${q}`);
  it('adds the saved filters to a list URL without any, keeping its tab, search and page', () => {
    expect(withSavedFilters(url('status=applied&page=2'), 'country=AE&days=0')!.search).toBe('?status=applied&page=2&country=AE&days=0');
  });

  it('leaves a URL with filters of its own, and does nothing without saved filters', () => {
    expect(withSavedFilters(url('country=PK'), 'country=AE')).toBeNull();
    expect(withSavedFilters(url('status=new'), undefined)).toBeNull();
    expect(withSavedFilters(url('status=new'), 'q=php&page=3')).toBeNull(); // nothing remembered in it
  });
});

describe('proxy', () => {
  const req = (path: string, cookie?: string, method = 'GET') =>
    new NextRequest(`http://localhost:3100${path}`, { method, headers: { host: 'localhost:3100', ...(cookie && { cookie }) } });

  it('saves the filters of a list URL in a cookie', () => {
    const res = proxy(req('/?status=new&country=AE&days=3&size=25'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.cookies.get(FILTER_COOKIE)?.value).toBe('country=AE&days=3&size=25');
  });

  it('sends a list URL without filters to the same URL with the saved ones', () => {
    const res = proxy(req('/?status=applied', `${FILTER_COOKIE}=${encodeURIComponent('country=AE&days=0')}`));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost:3100/?status=applied&country=AE&days=0');
  });

  it('leaves other pages, POSTs and a first visit alone', () => {
    const saved = `${FILTER_COOKIE}=country%3DAE`;
    for (const r of [req('/jobs/x', saved), req('/settings?country=PK', saved), req('/', saved, 'POST'), req('/')]) {
      const res = proxy(r);
      expect(res.headers.get('location')).toBeNull();
      expect(res.cookies.get(FILTER_COOKIE)).toBeUndefined();
    }
  });

  it('still refuses hosts other than this machine', () => {
    const res = proxy(new NextRequest('http://evil.example/', { headers: { host: 'evil.example' } }));
    expect(res.status).toBe(403);
  });
});
