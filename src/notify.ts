import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { Job } from './types.ts';

// Desktop notifications for strong AI matches (`ai:score`) and the daily fetch summary, so early applications go out
// the same morning. macOS, Linux (notify-send) and Windows (a PowerShell toast); elsewhere they are only logged.
// JOB_BOT_NOTIFY=off sends nothing; JOB_BOT_NOTIFY=<path> runs that program with (title, message, url) instead
// (tests use tests/fixtures/fake-notify.mjs, so they never show a real notification).

export const DASHBOARD_URL = 'http://localhost:3100';

export type Note = { title: string; message: string; url: string };
export type AlertJob = Pick<Job, 'id' | 'title' | 'company' | 'country'>;

/** Above this many strong jobs in one run, they share one notification. */
const GROUP_ABOVE = 3;

/** One line of plain text: control characters (newlines too) become spaces, long text is cut. */
const clean = (s: string, max: number) => {
  const t = s
    .replace(/\p{Cc}+/gu, ' ') // control characters
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** One notification per job, or a single grouped one when there are more than three. */
export function strongAlerts(jobs: AlertJob[], countryName: (code: string | null) => string): Note[] {
  if (jobs.length > GROUP_ABOVE) {
    const names = jobs
      .slice(0, GROUP_ABOVE)
      .map((j) => clean(`${j.title} at ${j.company}`, 60))
      .join(', ');
    return [{ title: 'Job Bot', message: clean(`${jobs.length} strong matches: ${names}…`, 240), url: DASHBOARD_URL }];
  }
  return jobs.map((j) => ({
    title: 'Job Bot',
    message: clean(`Strong match: ${j.title} at ${j.company} (${countryName(j.country)})`, 240),
    url: `${DASHBOARD_URL}/jobs/${encodeURIComponent(j.id)}`,
  }));
}

// The texts reach AppleScript as run-handler arguments, never as part of the script source, so quotes and
// backslashes in a job title cannot break out of a string literal.
const appleScript = (body: string) => ['-e', 'on run argv', '-e', body, '-e', 'end run'];
export const osascriptArgs = (n: Note) => [
  ...appleScript('display notification (item 2 of argv) with title (item 1 of argv)'),
  n.title,
  n.message,
];

// osascript notifications cannot open a link; terminal-notifier (Homebrew) can, so it is used when installed.
const TERMINAL_NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];

/** A PowerShell single-quoted string literal. PowerShell also ends such a literal at the typographic quotes ‘ ’ ‚ ‛, so those are doubled too. */
export const psQuote = (s: string) => `'${s.replace(/\p{Cc}+/gu, ' ').replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;

/**
 * The PowerShell script for a Windows toast: a clickable WinRT toast that opens the URL (Windows PowerShell 5.1,
 * which every Windows 10/11 has), else a tray balloon. The texts are quoted literals, and the whole script goes to
 * powershell.exe as -EncodedCommand (base64 UTF-16LE), so no command-line quoting is involved at all.
 */
export function windowsToastScript(n: Note): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$title = ${psQuote(n.title)}`,
    `$message = ${psQuote(n.message)}`,
    `$url = ${psQuote(n.url)}`,
    'try {',
    '  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]',
    '  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]',
    '  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `  $xml.LoadXml('<toast activationType="protocol"><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')`,
    "  $xml.DocumentElement.SetAttribute('launch', $url)",
    "  $texts = $xml.GetElementsByTagName('text')",
    '  $null = $texts.Item(0).AppendChild($xml.CreateTextNode($title))',
    '  $null = $texts.Item(1).AppendChild($xml.CreateTextNode($message))',
    // The AppUserModelID of Windows PowerShell itself: toasts need a registered app id, and this one always is.
    "  $app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    '  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    '} catch {',
    '  Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
    '  $icon = New-Object System.Windows.Forms.NotifyIcon',
    '  $icon.Icon = [System.Drawing.SystemIcons]::Information',
    '  $icon.Visible = $true',
    "  $icon.ShowBalloonTip(10000, $title, $message, 'Info')",
    '  Start-Sleep -Seconds 8',
    '  $icon.Dispose()',
    '}',
  ].join('\n');
}

export const powershellArgs = (n: Note) => [
  '-NoProfile',
  '-NonInteractive',
  '-WindowStyle',
  'Hidden',
  '-EncodedCommand',
  Buffer.from(windowsToastScript(n), 'utf16le').toString('base64'),
];

/** notify-send renders a markup subset in the body, so &, < and > are escaped. */
const markup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The first `name` (name.exe on Windows) in PATH, or null. */
export function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform, exists: (p: string) => boolean): string | null {
  const pathVar = Object.entries(env).find(([k]) => (platform === 'win32' ? k.toUpperCase() === 'PATH' : k === 'PATH'))?.[1] ?? '';
  const sep = platform === 'win32' ? ';' : ':';
  const join = platform === 'win32' ? win32.join : posix.join;
  for (const dir of pathVar.split(sep).filter(Boolean)) {
    for (const file of platform === 'win32' ? [`${name}.exe`, name] : [name]) {
      if (exists(join(dir, file))) return join(dir, file);
    }
  }
  return null;
}

/**
 * The program and arguments that show `n`, or null when notifications are off or this OS has no notifier. Never run
 * through a shell. macOS: terminal-notifier, else osascript. Linux: notify-send (libnotify). Windows: a PowerShell
 * toast. JOB_BOT_NOTIFY=<program> runs that instead on any OS.
 */
export function notifyCommand(
  n: Note,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] | null {
  const setting = env.JOB_BOT_NOTIFY;
  if (setting === 'off') return null;
  if (setting) return [setting, [n.title, n.message, n.url]];
  if (platform === 'darwin') {
    const tn = TERMINAL_NOTIFIER.find((p) => exists(p));
    if (tn) return [tn, ['-title', n.title, '-message', n.message, '-open', n.url]];
    return ['osascript', osascriptArgs(n)];
  }
  if (platform === 'win32') {
    const root = env.SystemRoot ?? env.SYSTEMROOT;
    const ps = root ? win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    return [ps, powershellArgs(n)];
  }
  const notifySend = onPath('notify-send', env, platform, exists);
  // "--" ends the options, so a message that starts with "-" is still text.
  if (notifySend) return [notifySend, ['--app-name=Job Bot', '--', n.title, `${markup(n.message)}\n${markup(n.url)}`]];
  return null;
}

type Run = (cmd: string, args: string[]) => Promise<void>;
const runFile: Run = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 15_000, windowsHide: true }, (e, _out, err) => {
      if (!e) return resolve();
      // Say why: killed after the timeout (e.g. the Mac was locked), or the program's own error.
      const why = e.killed ? `timed out after 15 s (${e.signal ?? 'killed'})` : `${e.code ?? ''} ${String(err).trim() || e.message}`.trim();
      reject(new Error(`${cmd.split(/[\\/]/).pop()}: ${why}`));
    });
  });

/**
 * Shows a notification with this OS's notifier. On macOS, if terminal-notifier fails, the plain osascript notification
 * is tried, so a strong match is not missed. A failure is logged, never thrown: alerts must not break scoring.
 */
export async function notify(
  n: Note,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  run: Run = runFile,
): Promise<void> {
  const cmd = notifyCommand(n, env, existsSync, platform);
  if (!cmd) {
    if (env.JOB_BOT_NOTIFY !== 'off') console.log(`  notification (no notifier on this system): ${n.title}: ${n.message}`);
    return;
  }
  try {
    await run(cmd[0], cmd[1]);
  } catch (e) {
    const fallback = platform === 'darwin' && cmd[0] !== 'osascript' && !env.JOB_BOT_NOTIFY;
    console.log(`  notification failed: ${(e as Error).message.slice(0, 300)}${fallback ? '; trying osascript' : ''}`);
    if (!fallback) return;
    await run('osascript', osascriptArgs(n)).catch((e2: Error) => console.log(`  notification failed: ${e2.message.slice(0, 300)}`));
  }
}
