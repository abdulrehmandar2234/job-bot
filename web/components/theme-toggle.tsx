'use client';

import { useEffect, useState } from 'react';
import { resolveTheme, THEME_KEY, type Theme } from '@/lib/theme';

const save = (t: Theme) => {
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
};

const saved = () => {
  try {
    return localStorage.getItem(THEME_KEY);
  } catch {
    return null;
  }
};

const systemQuery = () => window.matchMedia?.('(prefers-color-scheme: dark)');

/**
 * While the list's bulk-skip bar (components/triage.tsx, a form fixed at the bottom of the window) is open, the switch
 * moves up above it instead of sitting under it. Pure CSS, so it follows the bar on every render.
 */
export const ABOVE_BULK_BAR = '[body:has(form[aria-label^=Bulk])_&]:bottom-32';

/**
 * Day / night switch, in the bottom-right corner of every page (raised above the bulk-skip bar while it shows). Until it is used the dashboard follows the system
 * (and changes with it); a click saves the other theme in this browser. The head script in app/layout.tsx applies the
 * saved theme before the first paint.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>();

  useEffect(() => {
    const apply = () => {
      const t = resolveTheme(saved(), !!systemQuery()?.matches);
      document.documentElement.dataset.theme = t;
      setTheme(t);
    };
    apply();
    const mq = systemQuery();
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, []);

  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${next === 'dark' ? 'night' : 'day'} mode`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        save(next);
        setTheme(next);
      }}
      // Hidden until the theme is known, so the server render never shows the wrong icon.
      className={`fixed right-4 bottom-4 z-40 ${ABOVE_BULK_BAR} inline-flex size-10 items-center justify-center rounded-full border border-zinc-300 bg-background text-foreground shadow-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${theme ? '' : 'invisible'}`}
    >
      {theme === 'dark' ? <Sun /> : <Moon />}
    </button>
  );
}

const icon = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Sun() {
  return (
    <svg {...icon} aria-hidden="true" data-icon="sun">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function Moon() {
  return (
    <svg {...icon} aria-hidden="true" data-icon="moon">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
