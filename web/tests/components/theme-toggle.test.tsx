// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '@/components/theme-toggle';
import { resolveTheme, THEME_KEY, THEME_SCRIPT } from '@/lib/theme';

/** A system colour scheme the test can flip, like the OS switching to dark at sunset. */
function fakeSystem(dark: boolean) {
  const listeners = new Set<() => void>();
  const mq = {
    matches: dark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mq),
  );
  return {
    set(next: boolean) {
      mq.matches = next;
      for (const fn of listeners) fn();
    },
    listeners,
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('resolveTheme', () => {
  it('a saved choice wins; otherwise the system decides', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme('purple', false)).toBe('light');
  });
});

describe('THEME_SCRIPT (runs in <head> before the first paint)', () => {
  const run = () => new Function(THEME_SCRIPT)();

  it('applies the saved theme, else the system one', () => {
    fakeSystem(true);
    run();
    expect(document.documentElement.dataset.theme).toBe('dark');
    localStorage.setItem(THEME_KEY, 'light');
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('still sets a theme when storage is blocked', () => {
    fakeSystem(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    run();
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('ThemeToggle', () => {
  it('follows the system until clicked, then saves the other theme', async () => {
    const system = fakeSystem(true);
    render(<ThemeToggle />);
    const button = screen.getByRole('button', { name: 'Switch to day mode' });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(button.querySelector('[data-icon="sun"]')).not.toBeNull();
    // The system turns light: the page follows while nothing is saved.
    act(() => system.set(false));
    expect(document.documentElement.dataset.theme).toBe('light');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to night mode' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(screen.getByRole('button', { name: 'Switch to day mode' })).toBeInTheDocument();
    // A saved choice is kept when the system changes.
    act(() => system.set(false));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('starts from the saved choice, and stops listening when it unmounts', () => {
    const system = fakeSystem(true);
    localStorage.setItem(THEME_KEY, 'light');
    const { unmount } = render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to night mode' })).not.toHaveClass('invisible');
    unmount();
    expect(system.listeners.size).toBe(0);
  });

  it('still switches when storage is blocked', async () => {
    fakeSystem(false);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to night mode' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('globals.css', () => {
  const css = readFileSync(join(__dirname, '../../app/globals.css'), 'utf8');

  it("drives Tailwind's dark: variant and the colours from data-theme, with the system as the no-JS fallback", () => {
    expect(css).toMatch(/@custom-variant dark \{\s*&:where\(\[data-theme="dark"\], \[data-theme="dark"\] \*\)/);
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--background: #09090b;[^}]*color-scheme: dark;/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme\]\) \{/);
  });
});
