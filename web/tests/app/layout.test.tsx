import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RootLayout, { metadata } from '@/app/layout';

// next/font is compiled by Next itself; outside Next it only has to hand back the CSS variable class.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist-sans' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
}));

describe('root layout', () => {
  it('sets the page title and description', () => {
    expect(metadata.title).toBe('Job Bot');
    expect(metadata.description).toBe('Matching jobs in UAE, Saudi Arabia and the Netherlands');
  });

  it('renders an English document with both fonts, smooth scrolling Next.js can pause, and the page inside <body>', () => {
    const html = renderToStaticMarkup(
      RootLayout({ children: <main>dashboard</main>, params: Promise.resolve({}) } as Parameters<typeof RootLayout>[0]),
    );
    expect(html).toBe(
      '<html lang="en" data-scroll-behavior="smooth" class="font-geist-sans font-geist-mono h-full antialiased"><head></head>' +
        '<body class="min-h-full flex flex-col"><main>dashboard</main></body></html>',
    );
  });
});
