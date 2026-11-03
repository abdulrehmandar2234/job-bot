import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allTestFiles, DB_FREE, testCommands } from '../scripts/run-tests.mjs';

// npm scripts and git hooks must run on macOS, Linux and Windows (cmd.exe and PowerShell), so no POSIX shell syntax.
const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

describe('package.json scripts', () => {
  it('use no POSIX-only shell syntax', () => {
    for (const [name, script] of Object.entries(pkg.scripts)) {
      assert.doesNotMatch(script, /(^|\s)[A-Z_]+=\S/, `${name} sets an env var the sh way`);
      assert.doesNotMatch(script, /\$\{?[A-Z_]/, `${name} expands a variable the sh way`);
      assert.doesNotMatch(script, /'/, `${name} quotes with single quotes (cmd.exe keeps them)`);
      assert.doesNotMatch(script, /\|\| true|\bexport\b|\/dev\/null/, `${name} uses a POSIX-only command`);
    }
  });

  it('runs the tests and installs the hook through Node scripts', () => {
    assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs');
    assert.equal(pkg.scripts['test:coverage'], 'node scripts/run-tests.mjs --coverage');
    assert.equal(pkg.scripts.prepare, 'node scripts/install-hooks.mjs');
  });
});

describe('scripts/run-tests.mjs', () => {
  it('splits the default run: database-free files in parallel, then the DB files one at a time', () => {
    const runs = testCommands([], { PATH: '/bin' });
    assert.equal(runs.length, 2);
    const [free, db] = runs;
    assert.deepEqual(free.args.slice(0, 2), ['--no-warnings', '--test']);
    assert.ok(!free.args.includes('--test-concurrency=1'), 'database-free files use node’s default concurrency');
    assert.deepEqual([...free.args.slice(2)].sort(), [...DB_FREE].sort());
    assert.deepEqual(db.args.slice(0, 3), ['--no-warnings', '--test', '--test-concurrency=1']);
    for (const f of db.args.slice(3)) assert.ok(!DB_FREE.includes(f), `${f} is in both runs`);
    // Together the two runs cover every test file on disk, each exactly once.
    assert.deepEqual([...free.args.slice(2), ...db.args.slice(3)].sort(), allTestFiles());
    for (const { env } of runs) {
      assert.equal(env.DATABASE_URL, 'postgres://postgres@127.0.0.1:5432/job_bot_test_bot');
      assert.equal(env.PATH, '/bin');
    }
  });

  it('uses BOT_TEST_DB, given files and extra node flags, and one serialized run with coverage of src/', () => {
    const runs = testCommands(['--coverage', '--test-name-pattern=x', 'tests/a.test.ts'], { BOT_TEST_DB: 'job_bot_test_bot_wt1' });
    assert.equal(runs.length, 1);
    const { args, env } = runs[0];
    assert.equal(env.DATABASE_URL, 'postgres://postgres@127.0.0.1:5432/job_bot_test_bot_wt1');
    assert.deepEqual(args.slice(3), [
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      '--test-name-pattern=x',
      'tests/a.test.ts',
    ]);
    // Coverage without files needs a single run too, or node would write two partial reports.
    assert.deepEqual(testCommands(['--coverage'], {})[0].args.at(-1), 'tests/**/*.test.ts');
  });

  it('passes the exit code of the test run through', () => {
    const fail = spawnSync(process.execPath, [join(ROOT, 'scripts', 'run-tests.mjs'), 'tests/fixtures/does-not-exist.test.ts'], {
      encoding: 'utf8',
      env: { ...process.env, BOT_TEST_DB: 'job_bot_test_bot_none' },
    });
    assert.notEqual(fail.status, 0);
  });
});

describe('git setup', () => {
  it('checks out text files with LF on every OS (Biome, sh scripts and the hook need LF)', () => {
    assert.match(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), /^\* text=auto eol=lf$/m);
  });

  it('the pre-commit hook is a plain sh script, which Git for Windows runs too', () => {
    const hook = readFileSync(join(ROOT, '.githooks', 'pre-commit'), 'utf8');
    assert.match(hook, /^#!\/bin\/sh\n/);
    assert.doesNotMatch(hook, /\r/);
    assert.match(hook, /npx --no-install biome check --staged/);
  });
});

describe('child processes', () => {
  it('every module that starts one hides its console window on Windows (windowsHide)', () => {
    const files = [
      ...readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }).map((f) => join('src', f)),
      ...readdirSync(join(ROOT, 'web', 'lib'), { encoding: 'utf8' }).map((f) => join('web', 'lib', f)),
    ].filter((f) => f.endsWith('.ts'));
    const starters = files.filter((f) => /from 'node:child_process'/.test(readFileSync(join(ROOT, f), 'utf8')));
    assert.ok(starters.length >= 6, starters.join(', '));
    for (const f of starters) assert.match(readFileSync(join(ROOT, f), 'utf8'), /windowsHide: true/, f);
  });
});

describe('install guides (docs/install/*.md)', () => {
  const guide = (os: string) => readFileSync(join(ROOT, 'docs', 'install', `${os}.md`), 'utf8');
  const [macos, linux, windows] = ['macos', 'linux', 'windows'].map(guide);

  it('each covers its own scheduler and notifier, and points to schedule:print', () => {
    for (const text of ['launchd', 'schedule:print', 'terminal-notifier']) assert.ok(macos.includes(text), `macos: ${text}`);
    for (const text of ['OnCalendar=', 'Persistent=true', 'notify-send', 'schedule:print'])
      assert.ok(linux.includes(text), `linux: ${text}`);
    for (const text of ['Register-ScheduledTask', 'schtasks /Create', 'schedule:print'])
      assert.ok(windows.includes(text), `windows: ${text}`);
  });

  it('each says how to install the Chrome headless shell, like the setup wizard', () => {
    for (const g of [macos, linux, windows]) assert.match(g, /npx playwright-core install chromium-headless-shell/);
  });

  it('the docs index links every install guide (docs/SETUP.md, the old redirect stub, is gone)', () => {
    const index = readFileSync(join(ROOT, 'docs', 'README.md'), 'utf8');
    for (const page of ['install/macos.md', 'install/linux.md', 'install/windows.md']) assert.ok(index.includes(page), page);
    assert.ok(!readdirSync(join(ROOT, 'docs')).includes('SETUP.md'));
  });

  it('use the same scheduler lines as `bot schedule:print`', () => {
    assert.ok(linux.includes('ExecStart="/usr/bin/node" --no-warnings --env-file-if-exists=.env src/cli.ts daily'));
    assert.ok(windows.includes("-Argument '--no-warnings --env-file-if-exists=.env src/cli.ts daily'"));
    assert.ok(macos.includes('<string>/bin/zsh</string><string>/Users/<you>/job-bot/scripts/daily-fetch.sh</string>'));
  });
});
