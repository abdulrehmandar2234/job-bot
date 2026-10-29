import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Job } from './types.ts';

// macOS notifications for strong AI matches (`ai:score`), so early applications go out the same morning.
// JOB_BOT_NOTIFY=off sends nothing; JOB_BOT_NOTIFY=<path> runs that program with (title, message, url) instead
// (tests use tests/fixtures/fake-notify.mjs, so they never show a real notification).

export const DASHBOARD_URL = 'http://localhost:3100';

export type Note = { title: string; message: string; url: string };
export type AlertJob = Pick<Job, 'id' | 'title' | 'company' | 'country'>;

/** Above this many strong jobs in one run, they share one notification. */
const GROUP_ABOVE = 3;

/** One line of plain text: control characters (newlines too) become spaces, long text is cut. */
const clean = (s: string, max: number) => {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** One notification per job, or a single grouped one when there are more than three. */
export function strongAlerts(jobs: AlertJob[], countryName: (code: string | null) => string): Note[] {
  if (jobs.length > GROUP_ABOVE) {
    const names = jobs.slice(0, GROUP_ABOVE).map((j) => clean(`${j.title} at ${j.company}`, 60)).join(', ');
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
export const osascriptArgs = (n: Note) =>
  [...appleScript('display notification (item 2 of argv) with title (item 1 of argv)'), n.title, n.message];

// osascript notifications cannot open a link; terminal-notifier (Homebrew) can, so it is used when installed.
const TERMINAL_NOTIFIER = ['/opt/homebrew/bin/terminal-notifier', '/usr/local/bin/terminal-notifier'];

/** The program and arguments that show `n`, or null when notifications are off. Never run through a shell. */
export function notifyCommand(n: Note, env: NodeJS.ProcessEnv = process.env, exists = existsSync): [string, string[]] | null {
  const setting = env.JOB_BOT_NOTIFY;
  if (setting === 'off') return null;
  if (setting) return [setting, [n.title, n.message, n.url]];
  const tn = TERMINAL_NOTIFIER.find((p) => exists(p));
  if (tn) return [tn, ['-title', n.title, '-message', n.message, '-open', n.url]];
  return ['osascript', osascriptArgs(n)];
}

/** Shows a notification. A failure is logged, never thrown: alerts must not break scoring. */
export function notify(n: Note, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const cmd = notifyCommand(n, env);
  if (!cmd) return Promise.resolve();
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { timeout: 15_000 }, (e) => {
      if (e) console.log(`  notification failed: ${e.message.slice(0, 120)}`);
      resolve();
    });
  });
}
