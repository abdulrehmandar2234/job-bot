// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTIVE_OFFSET, activeSection, SettingsNav } from '@/components/settings-nav';
import { SETTINGS_GROUPS } from '@/lib/settings-sections';

const IDS = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.id));

describe('activeSection', () => {
  const tops = (...ns: number[]) => ns.map((top, i) => ({ id: `s${i}`, top }));

  it('is the last section whose top has scrolled past the offset', () => {
    expect(activeSection(tops(-900, -200, ACTIVE_OFFSET, 400), false)).toBe('s2');
    expect(activeSection(tops(-900, -200, ACTIVE_OFFSET + 1, 400), false)).toBe('s1');
  });

  it('is the first section before any has reached the offset', () => {
    expect(activeSection(tops(300, 900), false)).toBe('s0');
  });

  it('is the last section at the bottom of the page, even when it never reaches the offset', () => {
    expect(activeSection(tops(-900, 500, 700), true)).toBe('s2');
  });

  it('is nothing without sections', () => {
    expect(activeSection([], false)).toBeUndefined();
  });
});

describe('SettingsNav', () => {
  // A page of sections 600px apart, scrolled by `scrollY`; jsdom has no layout, so the rects are stubbed.
  const page = (height = 10_000) => {
    const els = IDS.map((id, i) => {
      const el = document.createElement('section');
      el.id = id;
      el.getBoundingClientRect = () => ({ top: i * 600 - window.scrollY }) as DOMRect;
      document.body.append(el);
      return el;
    });
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: height });
    return () => {
      for (const el of els) el.remove();
    };
  };
  const scrollTo = async (y: number) => {
    await act(async () => {
      window.scrollY = y;
      window.dispatchEvent(new Event('scroll'));
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
  };
  const current = () => screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'location');

  afterEach(() => {
    window.scrollY = 0;
    vi.restoreAllMocks();
  });

  it('links every group and section', () => {
    const clean = page();
    render(<SettingsNav />);
    const hrefs = within(screen.getByRole('navigation', { name: 'Settings sections' }))
      .getAllByRole('link')
      .map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(SETTINGS_GROUPS.flatMap((g) => [g.id, ...g.sections.map((s) => s.id)]).map((id) => `#${id}`));
    clean();
  });

  it('marks the section in view, and only that one, as the page scrolls', async () => {
    const clean = page();
    render(<SettingsNav />);
    expect(current().map((a) => a.textContent)).toEqual(['Matching']);
    await scrollTo(600 * 2);
    expect(current().map((a) => a.getAttribute('href'))).toEqual([`#${IDS[2]}`]);
    await scrollTo(600 * 2 - ACTIVE_OFFSET - 1);
    expect(current().map((a) => a.getAttribute('href'))).toEqual([`#${IDS[1]}`]);
    // The second group's first section: its group heading is highlighted too.
    const second = SETTINGS_GROUPS[1];
    await scrollTo(600 * IDS.indexOf(second.sections[0].id));
    expect(current().map((a) => a.textContent)).toEqual([second.sections[0].title]);
    expect(screen.getByRole('link', { name: second.title })).toHaveClass('text-zinc-900');
    expect(screen.getByRole('link', { name: SETTINGS_GROUPS[0].title })).toHaveClass('text-zinc-500');
    clean();
  });

  it('marks the last section once the page is scrolled to the bottom', async () => {
    const clean = page(2000);
    render(<SettingsNav />);
    await scrollTo(2000);
    expect(current().map((a) => a.getAttribute('href'))).toEqual([`#${IDS.at(-1)}`]);
    clean();
  });

  it('stops listening when it unmounts', async () => {
    const clean = page();
    const remove = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<SettingsNav />);
    unmount();
    expect(remove.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining(['scroll', 'resize']));
    clean();
  });
});

describe('smooth scrolling', () => {
  it('section links glide unless the reader asks for reduced motion, and Next.js can turn it off between pages', () => {
    const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*html \{\s*scroll-behavior: smooth;/);
    expect(readFileSync(join(__dirname, '../../app/layout.tsx'), 'utf8')).toContain('data-scroll-behavior="smooth"');
  });
});
