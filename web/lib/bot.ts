import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// The web app lives in job-bot/web; the bot (CLI, CVs, config) is one level up.
export const BOT_ROOT = resolve(process.cwd(), '..');

const run = promisify(execFile);

/** Runs the bot CLI (`npm run bot -- ...`) with an argument array — never through a shell. */
export async function runBot(args: string[], timeoutMs = 60_000) {
  const { stdout } = await run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: BOT_ROOT,
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true, // no console window flashing up on Windows
  });
  return stdout;
}

/**
 * Starts the bot CLI in the background and returns at once: a detached process (argument array, never a shell)
 * that outlives this request and the dev server. Its output is appended to data/logs/tasks.log.
 */
export function spawnBot(args: string[]) {
  const dir = join(BOT_ROOT, 'data', 'logs');
  mkdirSync(dir, { recursive: true });
  const log = openSync(join(dir, 'tasks.log'), 'a');
  try {
    const child = spawn(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
      cwd: BOT_ROOT,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true, // a detached child gets its own console window on Windows otherwise
    });
    // A spawn error leaves the task queued; expire_stale_tasks() fails it after 2 minutes.
    child.on('error', () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

export function cvFileName(): string {
  return JSON.parse(readFileSync(join(BOT_ROOT, 'config.json'), 'utf8')).cvFileName;
}

export function cvPath(version: string) {
  return version === 'default' ? join(BOT_ROOT, 'cv', 'default', cvFileName()) : join(BOT_ROOT, 'cv', 'versions', version, cvFileName());
}
