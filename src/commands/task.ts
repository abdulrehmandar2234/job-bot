import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { path, ROOT } from '../settings.ts';
import { claim, cliArgs, fail, finish, QUESTIONS_CAP, TASK_TIMEOUT_MS } from '../tasks.ts';

const run = promisify(execFile);

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
      { cwd: ROOT, timeout: TASK_TIMEOUT_MS[task.kind], maxBuffer: 10 * 1024 * 1024 },
    );
    await finish(id, stdout + stderr);
    console.log(`[${new Date().toISOString()}] task ${id}: done`);
  } catch (e) {
    const err = e as ExecFileException & { stdout?: string; stderr?: string };
    const message = err.killed ? `Timed out after ${TASK_TIMEOUT_MS[task.kind] / 60_000} minutes.` : err.stderr?.trim() || err.message;
    await fail(id, message, err.stdout ?? '');
    console.log(`[${new Date().toISOString()}] task ${id}: failed: ${message.slice(0, 300)}`);
  } finally {
    if (file) rmSync(file, { force: true });
  }
}
