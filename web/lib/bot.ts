import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { dataDir } from '../../src/settings.ts';
import { pool } from './db';

// The web app lives in talaash/web; the bot (CLI, CVs, config) is one level up.
export const BOT_ROOT = resolve(process.cwd(), '..');
/** The bot's data folder (logs, temp files, previews, the import token): JOB_BOT_DATA_DIR, else BOT_ROOT/data. */
export const botDataDir = () => dataDir(BOT_ROOT);

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

/** The bot could not be started (no log directory, no permission, …): an expected failure shown next to the button. */
export class BotStartError extends Error {}

/**
 * Fails a queued task whose worker never started, with the reason, so the dashboard shows it at once instead of
 * leaving it queued until the stale check. Only a still-queued task: a worker that did start owns its row.
 */
export async function failUnstartedTask(id: number, error: string) {
  await pool.query(`UPDATE tasks SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'queued'`, [id, error]);
}

/**
 * Starts the bot CLI in the background and returns at once: a detached process (argument array, never a shell)
 * that outlives this request and the dev server. Its output is appended to logs/tasks.log in the data folder (botDataDir).
 * When it cannot start, a `task:run <id>` task is marked failed with the reason; a failure before the process
 * exists (the log file, spawn itself) also throws BotStartError("Could not start the bot: …").
 */
export function spawnBot(args: string[]) {
  const taskId = args[0] === 'task:run' && /^\d+$/.test(args[1] ?? '') ? Number(args[1]) : null;
  const failed = (e: unknown) => {
    const message = `Could not start the bot: ${e instanceof Error ? e.message : String(e)}`;
    if (taskId !== null)
      failUnstartedTask(taskId, message).catch((err) => console.error(`task ${taskId}: ${message} (and could not record it: ${err})`));
    return message;
  };
  let log: number;
  try {
    const dir = join(botDataDir(), 'logs');
    mkdirSync(dir, { recursive: true });
    log = openSync(join(dir, 'tasks.log'), 'a');
  } catch (e) {
    throw new BotStartError(failed(e));
  }
  try {
    const child = spawn(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
      cwd: BOT_ROOT,
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true, // a detached child gets its own console window on Windows otherwise
    });
    // Most spawn failures (EACCES, ENOENT) arrive here, after this request has answered: the task is failed at once.
    child.on('error', failed);
    child.unref();
  } catch (e) {
    throw new BotStartError(failed(e));
  } finally {
    closeSync(log);
  }
}
