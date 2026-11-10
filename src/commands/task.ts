import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { redactKeys } from '../ai-providers.ts';
import { path, ROOT } from '../settings.ts';
import { claim, cliArgs, fail, finish, QUESTIONS_CAP, TASK_TIMEOUT_MS } from '../tasks.ts';

const run = promisify(execFile);

/** The last non-empty line of `text`, or ''. */
const lastLine = (text = '') =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * The error stored for a failed child. A killed child (the kind's timeout) keeps the last line of its stderr too: it
 * is usually the real error (the AI provider's message), printed before the process hung on. AI keys are redacted.
 */
export function failureMessage(err: ExecFileException & { stderr?: string }, timeoutMs: number): string {
  if (err.killed) {
    const note = `Timed out after ${timeoutMs / 60_000} minutes`;
    const last = lastLine(err.stderr).slice(0, 500);
    return redactKeys(last ? `${note} (last error: ${last})` : `${note}.`);
  }
  return redactKeys(err.stderr?.trim() || err.message);
}

/**
 * task:run <id>: the worker for one queued task, spawned detached by the dashboard. Claims the row, runs the
 * normal CLI command as a child (argument array, never a shell) with the kind's timeout, and stores the result.
 */
export async function taskRun(args: string[]) {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) return console.log('Usage: task:run <id>');
  const task = await claim(id);
  if (!task) return console.log(`Task ${id} is not queued (already running, finished or expired).`);
  console.log(`[${new Date().toISOString()}] task ${id}: ${task.kind}${task.job_id ? ` ${task.job_id}` : ''}`);

  let file: string | undefined;
  try {
    if (task.kind === 'answers') {
      const questions = String(task.args.questions ?? '')
        .trim()
        .slice(0, QUESTIONS_CAP);
      if (!questions) throw new Error('No questions given.');
      mkdirSync(path('data', 'questions'), { recursive: true });
      file = path('data', 'questions', `${randomUUID()}.txt`);
      writeFileSync(file, questions);
    }
    const { stdout, stderr } = await run(
      process.execPath,
      ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...cliArgs(task, file)],
      { cwd: ROOT, timeout: TASK_TIMEOUT_MS[task.kind], maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    );
    await finish(id, stdout + stderr);
    console.log(`[${new Date().toISOString()}] task ${id}: done`);
  } catch (e) {
    const err = e as ExecFileException & { stdout?: string; stderr?: string };
    const message = failureMessage(err, TASK_TIMEOUT_MS[task.kind]);
    await fail(id, message, err.stdout ?? '');
    console.log(`[${new Date().toISOString()}] task ${id}: failed: ${message.slice(0, 300)}`);
  } finally {
    if (file) rmSync(file, { force: true });
  }
}
