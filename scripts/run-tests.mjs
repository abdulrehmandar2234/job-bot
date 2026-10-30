// Runs the bot's tests (node:test) the same way on macOS, Linux and Windows. An npm script cannot set an env var in a
// form that sh, cmd.exe and PowerShell all accept (`DATABASE_URL=... node` is sh only), so `npm test` runs this.
//   node scripts/run-tests.mjs [--coverage] [--other-node-test-flags] [test files...]
// No files: every tests/**/*.test.ts. The database is job_bot_test_bot, or BOT_TEST_DB (tests/helpers.ts refuses others).
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The node arguments and env for a test run. */
export function testCommand(argv, env) {
  const coverage = argv.includes('--coverage');
  const flags = argv.filter((a) => a.startsWith('--') && a !== '--coverage');
  const files = argv.filter((a) => !a.startsWith('--'));
  return {
    args: [
      '--no-warnings',
      '--test',
      '--test-concurrency=1',
      ...(coverage ? ['--experimental-test-coverage', '--test-coverage-include=src/**'] : []),
      ...flags,
      // node expands the glob itself (no shell involved), with / on every OS.
      ...(files.length ? files : ['tests/**/*.test.ts']),
    ],
    env: { ...env, DATABASE_URL: `postgres://postgres@127.0.0.1:5432/${env.BOT_TEST_DB || 'job_bot_test_bot'}` },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { args, env } = testCommand(process.argv.slice(2), process.env);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (r.error) console.error(r.error.message);
  process.exit(r.status ?? 1);
}
