import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import RootLayout, { metadata } from '@/app/layout';
import { THEME_SCRIPT } from '@/lib/theme';

// next/font is compiled by Next itself; outside Next it only has to hand back the CSS variable class.
vi.mock('next/font/google', () => ({
  Geist: () => ({ variable: 'font-geist-sans' }),
  Geist_Mono: () => ({ variable: 'font-geist-mono' }),
}));

describe('root layout', () => {
  it('sets the page title and description', () => {
    expect(metadata.title).toBe('Talaash');
    // Nothing personal: the owner's markets come from config.json at runtime, never from the page metadata.
    expect(metadata.description).toBe('Finds, scores and prepares jobs for the countries in your settings');
    for (const owner of ['UAE', 'Saudi', 'Netherlands', 'Pakistan', 'Laravel']) expect(String(metadata.description)).not.toContain(owner);
  });

  const render = () => RootLayout({ children: <main>dashboard</main>, params: Promise.resolve({}) } as Parameters<typeof RootLayout>[0]);

  it('renders an English document with both fonts, smooth scrolling Next.js can pause, the theme script and the page', () => {
    const html = renderToStaticMarkup(render());
    expect(html).toMatch(
      /^<html lang="en" data-scroll-behavior="smooth" class="font-geist-sans font-geist-mono h-full antialiased"><head><script>/,
    );
    expect(html).toContain(`<script>${THEME_SCRIPT}</script></head>`);
    expect(html).toContain('<body class="min-h-full flex flex-col"><main>dashboard</main><button type="button" aria-label="Switch to ');
  });

  it('tolerates attributes a browser extension or the theme script adds to <html> and <body>', () => {
    const tree = render();
    expect(tree.props.suppressHydrationWarning).toBe(true);
    const [head, body] = tree.props.children;
    expect(head.type).toBe('head');
    expect(body.type).toBe('body');
    expect(body.props.suppressHydrationWarning).toBe(true);
    // Only the two outer elements: the page itself still reports real mismatches.
    expect(body.props.children[0].props.suppressHydrationWarning).toBeUndefined();
  });
});
