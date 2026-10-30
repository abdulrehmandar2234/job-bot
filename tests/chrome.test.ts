import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headlessShell, playwrightCache, resolveChrome } from '../src/cv/chrome.ts';

// Which Chrome prints PDFs: the headless shell first (no Dock icon on macOS), on every OS.

describe('playwrightCache', () => {
  it('uses the per-OS default, or PLAYWRIGHT_BROWSERS_PATH', () => {
    assert.equal(playwrightCache({}, 'darwin', '/Users/a'), join('/Users/a', 'Library', 'Caches', 'ms-playwright'));
    assert.equal(playwrightCache({}, 'linux', '/home/a'), join('/home/a', '.cache', 'ms-playwright'));
    assert.equal(playwrightCache({ XDG_CACHE_HOME: '/x' }, 'linux', '/home/a'), join('/x', 'ms-playwright'));
    assert.equal(
      playwrightCache({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'),
      join('C:\\Users\\a\\AppData\\Local', 'ms-playwright'),
    );
    assert.equal(playwrightCache({ PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }, 'darwin', '/Users/a'), '/opt/pw');
  });
});

describe('headlessShell', () => {
  it('finds the newest installed build, on any OS layout', () => {
    const cache = mkdtempSync(join(tmpdir(), 'jobbot-pw-'));
    try {
      assert.equal(headlessShell(join(cache, 'missing')), null);
      assert.equal(headlessShell(cache), null);
      for (const [build, sub, exe] of [
        ['chromium_headless_shell-1228', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        ['chromium_headless_shell-1248', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
        ['chromium-1300', 'chrome-mac', 'Chromium'], // a full Chromium, not the shell: ignored
      ]) {
        mkdirSync(join(cache, build, sub), { recursive: true });
        writeFileSync(join(cache, build, sub, exe), '');
      }
      assert.equal(
        headlessShell(cache),
        join(cache, 'chromium_headless_shell-1248', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('resolveChrome', () => {
  const shell = () => '/pw/chrome-headless-shell';
  const none = () => null;

  it('JOB_BOT_CHROME wins, then an explicit chromePath', () => {
    assert.equal(resolveChrome('/my/chrome', { JOB_BOT_CHROME: '/env/chrome' }, 'darwin', shell), '/env/chrome');
    assert.equal(resolveChrome('/my/chrome', {}, 'darwin', shell), '/my/chrome');
  });

  it('"auto" or missing: the headless shell first, so no Dock icon', () => {
    assert.equal(resolveChrome('auto', {}, 'darwin', shell), '/pw/chrome-headless-shell');
    assert.equal(resolveChrome(undefined, {}, 'linux', shell), '/pw/chrome-headless-shell');
  });

  it('falls back to a system Chrome for the OS, or null', () => {
    const has = (p: string) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' || p === '/usr/bin/chromium';
    assert.equal(resolveChrome('auto', {}, 'darwin', none, has), '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    assert.equal(resolveChrome('auto', {}, 'linux', none, has), '/usr/bin/chromium');
    assert.equal(
      resolveChrome('auto', {}, 'win32', none, () => false),
      null,
    );
  });
});
