// Light or dark: the choice the reader made with the toggle (components/theme-toggle.tsx), kept in localStorage,
// else the operating system's setting. It is written to <html data-theme>, which globals.css reads for the colours
// and Tailwind's dark: variant.

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'job-bot-theme';

/** The theme to show: the saved choice when there is a valid one, else the system's. */
export function resolveTheme(saved: string | null | undefined, systemDark: boolean): Theme {
  return saved === 'light' || saved === 'dark' ? saved : systemDark ? 'dark' : 'light';
}

/**
 * Runs in <head> before the page paints, so a saved light theme on a dark system (or the other way round) never
 * flashes the wrong colours. Kept tiny and self-contained: it cannot import anything. Storage can throw (blocked
 * cookies, private windows); the system theme is used then.
 */
export const THEME_SCRIPT = `(function(){var s=null;try{s=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;document.documentElement.dataset.theme=s==='light'||s==='dark'?s:d?'dark':'light'})()`;
