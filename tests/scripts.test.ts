import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testCommand } from '../scripts/run-tests.mjs';

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
  it('runs every test file against job_bot_test_bot by default', () => {
    const { args, env } = testCommand([], { PATH: '/bin' });
    assert.deepEqual(args, ['--no-warnings', '--test', '--test-concurrency=1', 'tests/**/*.test.ts']);
    assert.equal(env.DATABASE_URL, 'postgres://postgres@127.0.0.1:5432/job_bot_test_bot');
    assert.equal(env.PATH, '/bin');
  });

  it('uses BOT_TEST_DB, given files and extra node flags, and coverage of src/', () => {
    const { args, env } = testCommand(['--coverage', '--test-name-pattern=x', 'tests/a.test.ts'], { BOT_TEST_DB: 'job_bot_test_bot_wt1' });
    assert.equal(env.DATABASE_URL, 'postgres://postgres@127.0.0.1:5432/job_bot_test_bot_wt1');
    assert.deepEqual(args.slice(3), [
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      '--test-name-pattern=x',
      'tests/a.test.ts',
    ]);
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
