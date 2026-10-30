import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Which Chrome prints the CV and letter PDFs. "auto" (the default) prefers Playwright's chrome-headless-shell: a plain
// binary with no app bundle, so no Dock icon flashes up on macOS for every PDF, and it works the same on Windows and
// Linux. Install it once with `npx playwright-core install chromium-headless-shell`.

/** Where Playwright keeps its browsers on this OS (PLAYWRIGHT_BROWSERS_PATH wins). */
export function playwrightCache(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') return env.PLAYWRIGHT_BROWSERS_PATH;
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'ms-playwright');
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'ms-playwright');
}

/** The newest installed chrome-headless-shell in the Playwright cache, or null. */
export function headlessShell(cache = playwrightCache()): string | null {
  if (!existsSync(cache)) return null;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium_headless_shell-\d+$/.test(d))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    const dir = join(cache, build);
    for (const sub of readdirSync(dir)) {
      for (const exe of ['chrome-headless-shell', 'chrome-headless-shell.exe']) {
        const file = join(dir, sub, exe);
        if (existsSync(file)) return file;
      }
    }
  }
  return null;
}

/** System Chrome installs, per OS, for when no headless shell is installed. */
const SYSTEM_CHROME: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
};

/**
 * The Chrome binary to use: JOB_BOT_CHROME, else config `chromePath` when it is a path, else (for "auto" or a missing
 * value) the headless shell, else a system Chrome. Null when none is installed.
 */
export function resolveChrome(
  chromePath: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  shell: () => string | null = () => headlessShell(playwrightCache(env, platform)),
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (env.JOB_BOT_CHROME) return env.JOB_BOT_CHROME;
  if (chromePath && chromePath !== 'auto') return chromePath;
  return shell() ?? (SYSTEM_CHROME[platform] ?? []).find((p) => exists(p)) ?? null;
}
