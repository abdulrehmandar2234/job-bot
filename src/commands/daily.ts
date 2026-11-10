import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from '../config.ts';
import { DASHBOARD_URL, notify, type Note } from '../notify.ts';
import { path, ROOT } from '../settings.ts';
import { CACHE_MAX_AGE_DAYS, pruneCache } from '../sources/http.ts';
import { indRegisterStale } from '../sponsors.ts';

// daily: the scheduled morning run, the same on macOS, Linux and Windows (launchd runs it through
// scripts/daily-fetch.sh; cron, a systemd timer or Task Scheduler run it directly, see `bot schedule:print`).
// Refreshes the IND sponsor register when it is a week old, fetches jobs, marks closed postings expired, lets the AI
// review new matches, shows a notification with the result and backs up the database. Every step's output goes to
// data/fetch.log, and every step has a time limit, so one that hangs cannot block the rest (or the next day's run).

/** `timedOut`: the step ran past its time limit and was stopped. */
export type StepResult = { code: number; output: string; timedOut?: boolean };
export type DailyDeps = {
  /** Runs one CLI command (e.g. ['fetch']) with a time limit in ms, its output appended to the log. */
  run: (args: string[], timeoutMs: number) => Promise<StepResult>;
  notify: (n: Note) => Promise<void>;
  /** Appends text to the log. */
  log: (text: string) => void;
  /** Deletes stale http-cache entries; returns how many (default: pruneCache). */
  prune?: () => number;
  /** Renames logs that grew too big, before anything is written; returns a line per log it rotated. */
  rotate?: () => string[];
  /** Whether the IND sponsor register needs downloading again (default: never). */
  indStale?: () => boolean;
  /** Time limit per step in ms (default: STEP_TIMEOUT_MIN). */
  timeouts?: Partial<Record<DailyStep, number>>;
  now?: Date;
};

export const FETCH_FAILED = 'Fetch failed — is PostgreSQL running? See data/fetch.log';
export const AI_FAILED = 'AI review failed (is Claude signed in? See data/fetch.log)';

/** The time limit of each step, in minutes: a step still running then is stopped and the run goes on. */
export const STEP_TIMEOUT_MIN = { 'sponsors:update': 10, fetch: 30, 'check:open': 15, 'ai:score': 60, backup: 10 } as const;
export type DailyStep = keyof typeof STEP_TIMEOUT_MIN;
/** How long a step gets to exit after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 10_000;
/** Logs bigger than this are rotated to `<name>.1` at the start of the run. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

const stamp = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** "30 min", or seconds for the tiny limits tests use. */
const duration = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 100) / 10} s`);

/** The last line of `output` that matches. */
const lastLine = (output: string, re: RegExp) =>
  output
    .split(/\r?\n/)
    .filter((l) => re.test(l))
    .at(-1)
    ?.trim() ?? '';

// What `fetch` prints (src/commands/fetch.ts): "All N sources failed — … First error: <source>: <error>" when nothing
// came through, else "N of M sources failed (first error: …)" when some did not.
const ALL_FAILED = /^✗ All (\d+) sources failed\b.*?First error: (.*)$/m;
const SOME_FAILED = /^! (\d+) of (\d+) sources failed\b/m;
// A fetch that could not reach the database at all.
const DB_DOWN = /ECONNREFUSED|5432|PostgreSQL|postgres|database "[^"]*" does not exist|password authentication failed/i;

/** The notification text for a fetch that exited non-zero. */
export function fetchFailure(r: StepResult, timeoutMs: number): string {
  if (r.timedOut) return `Fetch timed out after ${duration(timeoutMs)}. See data/fetch.log`;
  const all = r.output.match(ALL_FAILED);
  if (all) return `Fetch failed: ${all[1]} of ${all[1]} sources failed — is the network up? First error: ${all[2].slice(0, 120)}`;
  if (DB_DOWN.test(r.output) || !r.output.trim()) return FETCH_FAILED;
  const last = r.output.trim().split(/\r?\n/).at(-1)?.trim() ?? '';
  return `Fetch failed: ${last.slice(0, 160)} See data/fetch.log`;
}

/**
 * The steps, in order: the IND register refresh (only when it is stale; failures only show in the log); fetch; then
 * (only if it worked) check:open and ai:score, each best-effort; a notification with the result; the backup, after the
 * notification, so a failed backup only shows in the log; and the http-cache prune, whose result also only shows in
 * the log. Each step is stopped after its time limit (STEP_TIMEOUT_MIN) and the run goes on.
 */
export async function runDaily(d: DailyDeps): Promise<void> {
  // Rotate before the first write, so this run starts a fresh log when the old one is too big.
  let rotated: string[] = [];
  let rotateError = '';
  try {
    rotated = d.rotate?.() ?? [];
  } catch (e) {
    rotateError = (e as Error).message;
  }
  d.log(`\n===== ${stamp(d.now ?? new Date())} =====\n`);
  for (const line of rotated) d.log(`${line}\n`);
  if (rotateError) d.log(`log rotation failed: ${rotateError}\n`);

  const timedOut: string[] = [];
  const limit = (name: DailyStep) => d.timeouts?.[name] ?? STEP_TIMEOUT_MIN[name] * 60_000;
  const step = async (name: DailyStep, ...args: string[]) => {
    const r = await d.run([name, ...args], limit(name));
    if (r.timedOut) {
      d.log(`\n${name} timed out after ${duration(limit(name))}\n`);
      timedOut.push(name);
    }
    return r;
  };

  // Dutch postings are filtered against the register: an old copy filters out newly recognised sponsors.
  if (d.indStale?.()) {
    if ((await step('sponsors:update')).code !== 0) d.log('sponsors:update failed (see above); the IND register stays as it was\n');
  }

  let message: string;
  const fetched = await step('fetch');
  if (fetched.code === 0) {
    // Dead-link check: postings that have closed move to `expired`.
    if ((await step('check:open', '--limit', '100')).code !== 0) d.log('check:open failed (see above)\n');
    // AI review is a bonus: a failure here (e.g. Claude signed out) must not hide the fetch result.
    const scored = await step('ai:score');
    const ai = scored.timedOut ? '' : scored.code === 0 ? lastLine(scored.output, /^\d+ jobs scored/) : AI_FAILED;
    const summary = lastLine(fetched.output, /postings checked/);
    const some = fetched.output.match(SOME_FAILED);
    const sources = some ? `${some[1]} of ${some[2]} sources failed.` : '';
    message = [summary, sources, ai].filter(Boolean).join(' ') || 'Fetch done.';
  } else {
    message = fetchFailure(fetched, limit('fetch'));
  }
  // The fetch's own timeout is already the message.
  const late = timedOut.filter((s) => s !== 'fetch');
  if (late.length) message += ` Timed out: ${late.join(', ')} (see data/fetch.log).`;
  const note: Note = { title: 'Job Bot', message, url: DASHBOARD_URL };
  d.log(`notification: ${note.message}\n`);
  await d.notify(note);
  // Daily database backup (keeps 14).
  if ((await step('backup')).code !== 0) d.log('backup failed (see above)\n');
  // Housekeeping: the on-disk ETag cache (data/http-cache) has no other eviction and would grow forever.
  try {
    d.log(`http-cache: removed ${(d.prune ?? pruneCache)()} entries older than ${CACHE_MAX_AGE_DAYS} days\n`);
  } catch (e) {
    d.log(`http-cache prune failed: ${(e as Error).message}\n`);
  }
}

/**
 * Renames each file bigger than `maxBytes` to `<file>.1` (replacing an older `.1`), so the logs the bot appends to
 * forever stay small. Returns a line per rotated file; a file that cannot be renamed (open elsewhere on Windows) is
 * reported and left alone.
 */
export function rotateLogs(files: string[], maxBytes = LOG_MAX_BYTES): string[] {
  const out: string[] = [];
  for (const file of files) {
    try {
      if (!existsSync(file) || statSync(file).size <= maxBytes) continue;
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
      out.push(`rotated ${file} to ${file}.1`);
    } catch (e) {
      out.push(`could not rotate ${file}: ${(e as Error).message}`);
    }
  }
  return out;
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
 * `logFile` as they come, and returns the exit code and the output. Past `timeoutMs` the child gets SIGTERM, and
 * SIGKILL `graceMs` later if it is still there; the result then has `timedOut` (and code 124, like timeout(1)).
 */
export function cliRunner(logFile: string, cli = 'src/cli.ts', env: NodeJS.ProcessEnv = process.env, graceMs = KILL_GRACE_MS) {
  return (args: string[], timeoutMs = 0) =>
    new Promise<StepResult>((resolve) => {
      let output = '';
      let timedOut = false;
      let settled = false;
      const timers: NodeJS.Timeout[] = [];
      const done = (r: StepResult) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        resolve(r);
      };
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
        done({ code: 1, output });
      });
      child.on('close', (code) => done(timedOut ? { code: 124, output, timedOut } : { code: code ?? 1, output }));
      // A stopped step's own children (pg_dump, the Claude CLI) may hold its pipes open, so 'close' could wait on
      // them: 'exit' is enough here.
      child.on('exit', () => {
        if (timedOut) done({ code: 124, output, timedOut });
      });
      if (timeoutMs > 0) {
        timers.push(
          setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            timers.push(setTimeout(() => child.kill('SIGKILL'), graceMs));
          }, timeoutMs),
        );
      }
    });
}

/** Whether config.json has a country that checks the IND register (only then is it worth downloading). */
export function usesIndRegister(): boolean {
  try {
    return Object.values(loadConfig().countries).some((c) => c.visa === 'ind-register');
  } catch {
    return false; // a broken config.json: fetch reports it
  }
}

/** daily: the scheduled run. Works from any folder (Task Scheduler's schtasks cannot set one). */
export async function daily() {
  // The children load .env themselves; this process needs it for JOB_BOT_NOTIFY. Variables already set win.
  if (existsSync(path('.env'))) process.loadEnvFile(path('.env'));
  mkdirSync(path('data'), { recursive: true });
  const logFile = path('data', 'fetch.log');
  await runDaily({
    run: cliRunner(logFile),
    notify: (n) => notify(n),
    log: (t) => appendFileSync(logFile, t),
    // data/logs/tasks.log is the dashboard's task log (web/lib/bot.ts), launchd.err.log the macOS scheduler's stderr.
    rotate: () => rotateLogs([logFile, path('data', 'logs', 'tasks.log'), path('data', 'launchd.err.log')]),
    indStale: () => usesIndRegister() && indRegisterStale(),
  });
}
