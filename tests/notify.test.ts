import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import {
  dashboardUrl,
  notify,
  notifyCommand,
  onPath,
  osascriptArgs,
  powershellArgs,
  psQuote,
  strongAlerts,
  windowsToastScript,
  type AlertJob,
} from '../src/notify.ts';

// Notifications per OS, with an injected platform and file check: no database, and no real notification is shown.
const run = promisify(execFile);
const n = { title: 'T', message: 'M', url: 'http://localhost:3100/jobs/1' };
const evil = 'Say "hi" \\" & do shell script "touch /tmp/pwned" & \' ; $(calc) `whoami` ‘x’ %PATH% <b>';
const decode = (args: string[]) => Buffer.from(args.at(-1)!, 'base64').toString('utf16le');

describe('strongAlerts', () => {
  const job = (i: number, o: Partial<AlertJob> = {}): AlertJob => ({
    id: `x:${i}`,
    title: `Dev ${i}`,
    company: `Co${i}`,
    country: 'NL',
    ...o,
  });
  const name = (c: string | null) => c ?? '?';

  it('sends up to three single notes and groups above that', () => {
    assert.equal(strongAlerts([job(1), job(2), job(3)], name).length, 3);
    assert.deepEqual(strongAlerts([job(1), job(2), job(3), job(4), job(5)], name), [
      { title: 'Talaash', message: '5 strong matches: Dev 1 at Co1, Dev 2 at Co2, Dev 3 at Co3…', url: 'http://localhost:3100' },
    ]);
    assert.deepEqual(strongAlerts([], name), []);
  });

  it('keeps each message on one short line', () => {
    const [note] = strongAlerts([job(1, { title: 'Dev\nline\ttwo\u0007', company: 'x'.repeat(400) })], name);
    assert.match(note.message, /^Strong match: Dev line two at x+…$/);
    assert.equal(note.message.length, 240);
  });

  it('JOB_BOT_DASHBOARD_URL overrides the dashboard address in notification links', () => {
    const saved = process.env.JOB_BOT_DASHBOARD_URL;
    try {
      delete process.env.JOB_BOT_DASHBOARD_URL;
      assert.equal(dashboardUrl(), 'http://localhost:3100');
      process.env.JOB_BOT_DASHBOARD_URL = 'http://localhost:4000';
      assert.equal(dashboardUrl(), 'http://localhost:4000');
      assert.equal(strongAlerts([job(1)], name)[0].url, 'http://localhost:4000/jobs/x%3A1');
      assert.equal(strongAlerts([job(1), job(2), job(3), job(4)], name)[0].url, 'http://localhost:4000');
    } finally {
      if (saved === undefined) delete process.env.JOB_BOT_DASHBOARD_URL;
      else process.env.JOB_BOT_DASHBOARD_URL = saved;
    }
  });
});

describe('notifyCommand', () => {
  it('JOB_BOT_NOTIFY: off sends nothing, a program gets (title, message, url) on any OS', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      assert.equal(
        notifyCommand(n, { JOB_BOT_NOTIFY: 'off' }, () => true, platform),
        null,
      );
      assert.deepEqual(
        notifyCommand(n, { JOB_BOT_NOTIFY: '/x/fake' }, () => true, platform),
        ['/x/fake', ['T', 'M', n.url]],
      );
    }
  });

  it('macOS: terminal-notifier when installed, else osascript', () => {
    assert.deepEqual(
      notifyCommand(n, {}, (p) => p === '/opt/homebrew/bin/terminal-notifier', 'darwin'),
      ['/opt/homebrew/bin/terminal-notifier', ['-title', 'T', '-message', 'M', '-open', n.url]],
    );
    assert.deepEqual(
      notifyCommand(n, {}, () => false, 'darwin'),
      ['osascript', osascriptArgs(n)],
    );
  });

  it('Linux: notify-send from PATH, with the texts after "--" and the body markup escaped', () => {
    const has = (p: string) => p === '/usr/bin/notify-send';
    assert.deepEqual(notifyCommand({ ...n, message: '-x <b>&' }, { PATH: '/nope:/usr/bin' }, has, 'linux'), [
      '/usr/bin/notify-send',
      ['--app-name=Talaash', '--', 'T', `-x &lt;b&gt;&amp;\n${n.url}`],
    ]);
  });

  it('Linux without notify-send: no command, so the note is only logged; other Unixes use notify-send too', () => {
    assert.equal(
      notifyCommand(n, { PATH: '/usr/bin:/bin' }, () => false, 'linux'),
      null,
    );
    assert.deepEqual(
      notifyCommand(n, { PATH: '/usr/local/bin' }, () => true, 'freebsd'),
      [posix.join('/usr/local/bin', 'notify-send'), ['--app-name=Talaash', '--', 'T', `M\n${n.url}`]],
    );
  });

  it('Windows: Windows PowerShell from SystemRoot, the script passed encoded', () => {
    const [cmd, args] = notifyCommand(n, { SystemRoot: 'C:\\Windows' }, () => false, 'win32')!;
    assert.equal(cmd, win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand']);
    assert.equal(decode(args), windowsToastScript(n));
    assert.equal(notifyCommand(n, {}, () => false, 'win32')![0], 'powershell.exe');
  });
});

describe('onPath', () => {
  it('searches PATH with the OS separator, and name.exe first on Windows (Path in any case)', () => {
    assert.equal(
      onPath('x', { PATH: '/a:/b' }, 'linux', (p) => p === '/b/x'),
      '/b/x',
    );
    assert.equal(
      onPath('x', { Path: 'C:\\a;C:\\b' }, 'win32', (p) => p === 'C:\\b\\x.exe'),
      'C:\\b\\x.exe',
    );
    assert.equal(
      onPath('x', {}, 'linux', () => true),
      null,
    );
  });
});

describe('PowerShell quoting', () => {
  it('psQuote doubles every kind of single quote and drops control characters', () => {
    assert.equal(psQuote("it's"), "'it''s'");
    assert.equal(psQuote('a\u2019b\u2018c'), "'a\u2019\u2019b\u2018\u2018c'");
    assert.equal(psQuote('a\nb\r\u0000c'), "'a b c'");
    assert.equal(psQuote('$(x) `y` "z"'), '\'$(x) `y` "z"\'');
  });

  it('the texts appear only as quoted literals in the toast script', () => {
    const script = windowsToastScript({ title: 'Talaash', message: evil, url: 'http://localhost:3100/jobs/a%27b' });
    assert.ok(script.includes(`$message = ${psQuote(evil)}`));
    assert.equal(script.split(evil.slice(0, 8)).length, 2, 'the message appears once');
    assert.match(script, /\$xml\.DocumentElement\.SetAttribute\('launch', \$url\)/);
    assert.match(script, /ShowBalloonTip/, 'falls back to a tray balloon when toasts fail');
  });

  it('powershellArgs is a fixed argument list plus base64 UTF-16LE of the script', () => {
    const args = powershellArgs({ title: 'T', message: evil, url: 'u' });
    assert.equal(args.length, 6);
    assert.ok(args.slice(0, -1).every((a) => !a.includes('Say')));
    assert.match(args.at(-1)!, /^[A-Za-z0-9+/]+=*$/);
  });

  it('a quoted text reaches PowerShell unchanged', { skip: process.platform !== 'win32' }, async () => {
    // PowerShell prints the UTF-16 code units as numbers, so the console code page cannot garble the comparison.
    const script = `Write-Output (([int[]][char[]](${psQuote(evil)})) -join ',')`;
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
    assert.equal(stdout.trim(), Array.from(evil, (c) => c.charCodeAt(0)).join(','));
  });
  it('the toast script parses without errors in Windows PowerShell', { skip: process.platform !== 'win32' }, async () => {
    const toast = Buffer.from(windowsToastScript({ title: 'Talaash', message: evil, url: 'http://localhost:3100' }), 'utf16le').toString(
      'base64',
    );
    const script = [
      `$s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${toast}'))`,
      '$tokens = $null; $errors = $null',
      '$null = [System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$tokens, [ref]$errors)',
      'Write-Output $errors.Count',
    ].join('\n');
    const { stdout } = await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ]);
    assert.equal(stdout.trim(), '0');
  });
});

describe('osascript', () => {
  it('gets the texts as arguments, never inside the script source', () => {
    const args = osascriptArgs({ title: 'Talaash', message: evil, url: 'u' });
    assert.deepEqual(args.slice(-2), ['Talaash', evil]);
    assert.ok(args.slice(0, -2).every((a) => !a.includes(evil)));
  });

  it('quotes and backslashes reach AppleScript unchanged', { skip: process.platform !== 'darwin' }, async () => {
    // Same argument layout as the real call, with `return` in place of `display notification`.
    const args = osascriptArgs({ title: 'Job "Bot"', message: evil, url: 'u' }).map((a) =>
      a.startsWith('display notification') ? 'return (item 1 of argv) & "|" & (item 2 of argv)' : a,
    );
    const { stdout } = await run('osascript', args);
    assert.equal(stdout.trim(), `Job "Bot"|${evil}`);
  });
});

describe('notify', () => {
  it('logs a failing notifier instead of throwing', async () => {
    await notify({ title: 'T', message: 'M', url: 'u' }, { JOB_BOT_NOTIFY: '/nonexistent/notifier' });
  });

  it('logs the note when this system has no notifier, and nothing when notifications are off', async () => {
    const log = mock.method(console, 'log', () => {});
    try {
      await notify(n, { PATH: '' }, 'aix');
      await notify(n, { JOB_BOT_NOTIFY: 'off' }, 'aix');
      assert.deepEqual(
        log.mock.calls.map((c) => c.arguments[0]),
        ['  notification (no notifier on this system): T: M'],
      );
    } finally {
      log.mock.restore();
    }
  });
});
