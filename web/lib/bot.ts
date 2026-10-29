import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  });
  return stdout;
}

export function cvFileName(): string {
  return JSON.parse(readFileSync(join(BOT_ROOT, 'config.json'), 'utf8')).cvFileName;
}

export function cvPath(version: string) {
  return version === 'default'
    ? join(BOT_ROOT, 'cv', 'default', cvFileName())
    : join(BOT_ROOT, 'cv', 'versions', version, cvFileName());
}
