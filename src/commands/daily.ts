import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { DASHBOARD_URL, notify, type Note } from '../notify.ts';
import { path, ROOT } from '../settings.ts';

// daily: the scheduled morning run, the same on macOS, Linux and Windows (launchd runs it through
// scripts/daily-fetch.sh; cron, a systemd timer or Task Scheduler run it directly, see `bot schedule:print`).
// Fetches jobs, marks closed postings expired, lets the AI review new matches, shows a notification with the result
// and backs up the database. Every step's output goes to data/fetch.log.

export type StepResult = { code: number; output: string };
export type DailyDeps = {
  /** Runs one CLI command (e.g. ['fetch']), its output appended to the log. */
  run: (args: string[]) => Promise<StepResult>;
  notify: (n: Note) => Promise<void>;
  /** Appends text to the log. */
  log: (text: string) => void;
  now?: Date;
};

export const FETCH_FAILED = 'Fetch failed — is PostgreSQL running? See data/fetch.log';
export const AI_FAILED = 'AI review failed (is Claude signed in? See data/fetch.log)';

const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** The last line of `output` that matches. */
const lastLine = (output: string, re: RegExp) =>
  output
    .split(/\r?\n/)
    .filter((l) => re.test(l))
    .at(-1)
    ?.trim() ?? '';

/**
 * The steps, in order: fetch; then (only if it worked) check:open and ai:score, each best-effort; a notification with
 * the result; and the backup, after the notification, so a failed backup only shows in the log.
 */
export async function runDaily(d: DailyDeps): Promise<void> {
  d.log(`\n===== ${stamp(d.now ?? new Date())} =====\n`);
  let note: Note;
  const fetched = await d.run(['fetch']);
  if (fetched.code === 0) {
    // Dead-link check: postings that have closed move to `expired`.
    if ((await d.run(['check:open', '--limit', '100'])).code !== 0) d.log('check:open failed (see above)\n');
    // AI review is a bonus: a failure here (e.g. Claude signed out) must not hide the fetch result.
    const scored = await d.run(['ai:score']);
    const ai = scored.code === 0 ? lastLine(scored.output, /^\d+ jobs scored/) : AI_FAILED;
    const summary = lastLine(fetched.output, /postings checked/);
    note = { title: 'Job Bot', message: `${summary} ${ai}`.trim() || 'Fetch done.', url: DASHBOARD_URL };
  } else {
    note = { title: 'Job Bot', message: FETCH_FAILED, url: DASHBOARD_URL };
  }
  d.log(`notification: ${note.message}\n`);
  await d.notify(note);
  // Daily database backup (keeps 14).
  if ((await d.run(['backup'])).code !== 0) d.log('backup failed (see above)\n');
}

/** PATH for the child commands, with ~/.local/bin first (where the Claude CLI installs itself on every OS). */
export function childEnv(env: NodeJS.ProcessEnv, home = homedir(), platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => (platform === 'win32' ? k.toUpperCase() === 'PATH' : k === 'PATH')) ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const local = platform === 'win32' ? `${home}\\.local\\bin` : `${home}/.local/bin`;
  const dirs = (env[key] ?? '').split(sep).filter(Boolean);
  return { ...env, [key]: (dirs.includes(local) ? dirs : [local, ...dirs]).join(sep) };
}

/**
 * Runs `node <cli> <args>` in the repository (argument array, never a shell), appending its stdout and stderr to
 * `logFile` as they come, and returns the exit code and the output.
 */
export function cliRunner(logFile: string, cli = 'src/cli.ts', env: NodeJS.ProcessEnv = process.env) {
  return (args: string[]) =>
    new Promise<StepResult>((resolve) => {
      let output = '';
      const write = (chunk: Buffer) => {
        output += chunk;
        appendFileSync(logFile, chunk);
      };
      const child = spawn(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', cli, ...args], {
        cwd: ROOT,
        env: childEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', write);
      child.stderr.on('data', write);
      child.on('error', (e) => {
        appendFileSync(logFile, `${e.message}\n`);
        resolve({ code: 1, output });
      });
      child.on('close', (code) => resolve({ code: code ?? 1, output }));
    });
}

/** daily: the scheduled run. Works from any folder (Task Scheduler's schtasks cannot set one). */
export async function daily() {
  // The children load .env themselves; this process needs it for JOB_BOT_NOTIFY. Variables already set win.
  if (existsSync(path('.env'))) process.loadEnvFile(path('.env'));
  mkdirSync(path('data'), { recursive: true });
  const logFile = path('data', 'fetch.log');
  await runDaily({ run: cliRunner(logFile), notify: (n) => notify(n), log: (t) => appendFileSync(logFile, t) });
}
