// Runs the bot's tests (node:test) the same way on macOS, Linux and Windows. An npm script cannot set an env var in a
// form that sh, cmd.exe and PowerShell all accept (`DATABASE_URL=... node` is sh only), so `npm test` runs this.
//   node scripts/run-tests.mjs [--coverage] [--other-node-test-flags] [test files...]
// No files: the database-free files first with node's default concurrency, then the files that share the test database
// one at a time. The database is job_bot_test_bot, or BOT_TEST_DB (tests/helpers.ts refuses others).
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Test files that never open the database: the same list the Windows CI job runs (tests/ci.test.ts keeps the two
// equal). They can run in parallel; the DB files share tables and advisory locks, so they stay at concurrency 1.
export const DB_FREE = [
  'tests/scripts.test.ts',
  'tests/notify.test.ts',
  'tests/backup.test.ts',
  'tests/daily.test.ts',
  'tests/chrome.test.ts',
  'tests/ci.test.ts',
  'tests/settings.test.ts',
  'tests/match.test.ts',
  'tests/salary.test.ts',
  'tests/http.test.ts',
  'tests/ai-providers.test.ts',
  'tests/sources.test.ts',
  'tests/extension.test.ts',
];

/** Every tests/**\/*.test.ts, sorted, with / on every OS. */
export const allTestFiles = () =>
  readdirSync(resolve(ROOT, 'tests'), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => `tests/${f.replaceAll('\\', '/')}`)
    .sort();

/** The node argument lists and env for a test run: one entry per node invocation, run in order. */
export function testCommands(argv, env) {
  const coverage = argv.includes('--coverage');
  const flags = argv.filter((a) => a.startsWith('--') && a !== '--coverage');
  const files = argv.filter((a) => !a.startsWith('--'));
  const run = (own, runFiles) => ({
    args: [
      '--no-warnings',
      '--test',
      ...own,
      ...(coverage ? ['--experimental-test-coverage', '--test-coverage-include=src/**'] : []),
      ...flags,
      ...runFiles,
    ],
    env: { ...env, DATABASE_URL: `postgres://postgres@127.0.0.1:5432/${env.BOT_TEST_DB || 'job_bot_test_bot'}` },
  });
  // Named files keep one serialized run (they may be DB files), and coverage needs one run for one report.
  // node expands the glob itself (no shell involved), with / on every OS.
  if (files.length || coverage) return [run(['--test-concurrency=1'], files.length ? files : ['tests/**/*.test.ts'])];
  const all = allTestFiles();
  return [
    run(
      [],
      all.filter((f) => DB_FREE.includes(f)),
    ),
    run(
      ['--test-concurrency=1'],
      all.filter((f) => !DB_FREE.includes(f)),
    ),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const { args, env } of testCommands(process.argv.slice(2), process.env)) {
    const r = spawnSync(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
    if (r.error) console.error(r.error.message);
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}
