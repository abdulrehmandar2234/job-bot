import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FREE } from '../scripts/run-tests.mjs';

// The GitHub Actions workflow: least-privilege token, one run per branch, and no double runs on pull requests.
const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');
const dependabot = readFileSync(join(import.meta.dirname, '..', '.github', 'dependabot.yml'), 'utf8');
const pkg = (dir: string) => JSON.parse(readFileSync(join(import.meta.dirname, '..', dir, 'package.json'), 'utf8'));
const ubuntuJob = () => workflow.slice(workflow.indexOf('\n  test:'), workflow.indexOf('\n  portable:'));
const windowsJob = () => workflow.slice(workflow.indexOf('\n  portable:'));

describe('.github/workflows/test.yml', () => {
  it('runs on pull requests and pushes to main only (never both refs of one PR), plus a monthly schedule', () => {
    assert.match(workflow, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n/m);
    assert.match(workflow, /^ {2}schedule:\n {4}- cron: "[\d*/ ]+"\n/m);
  });

  it('gives the token read-only access to the repository contents', () => {
    assert.match(workflow, /^permissions:\n {2}contents: read\n/m);
  });

  it('cancels an older run of the same workflow and ref', () => {
    assert.match(
      workflow,
      /^concurrency:\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/m,
    );
  });
});

describe('.github/workflows/test.yml jobs', () => {
  it('keeps the Ubuntu job with PostgreSQL and the full suites', () => {
    assert.match(workflow, /^ {2}test:\n {4}runs-on: ubuntu-latest\n/m);
    assert.match(workflow, /image: postgres:18/);
    assert.match(workflow, /- run: npm test\n {6}- run: npm run test:web/);
  });

  it('builds the dashboard on Ubuntu, so a bundling break of its ../src imports fails CI, not the user', () => {
    assert.match(
      ubuntuJob(),
      /- run: npm --prefix web run build\n {8}env:\n {10}DATABASE_URL: postgres:\/\/postgres@127\.0\.0\.1:5432\/job_bot_test\n/,
    );
  });

  it('runs install, typecheck and the database-free tests on Windows, but not Biome (Ubuntu lints already)', () => {
    const job = windowsJob();
    assert.match(job, /os: \[windows-latest\]/);
    for (const step of ['npm ci', 'npm ci --prefix web', 'npm run typecheck']) assert.ok(job.includes(`- run: ${step}\n`), step);
    assert.ok(!job.includes('biome'), 'Biome is platform-independent and already runs in the Ubuntu job');
    // The same list as the parallel pass of scripts/run-tests.mjs: database-free there means Windows-safe here.
    const files = [...job.matchAll(/tests\/[\w-]+\.test\.ts/g)].map((m) => m[0]);
    assert.deepEqual(files, [...DB_FREE]);
    // None of them may need the database: no import of src/db.ts or pg.
    for (const f of files)
      assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', f), 'utf8'), /^import .*(src\/db\.ts|'pg');$/m, f);
  });
});

describe('.github/workflows/test.yml Node versions and coverage', () => {
  it('runs the Windows job on Node 24 (the engines minimum) and Node 26', () => {
    const job = windowsJob();
    assert.match(job, /^ {8}node: \[24, 26\]\n/m);
    assert.match(job, /node-version: \$\{\{ matrix\.node \}\}\n/);
    assert.doesNotMatch(job, /node-version: \d/, 'no hard-coded Node version left in the matrix job');
  });

  it('keeps the Ubuntu job on Node 24, the engines minimum of the bot and the dashboard', () => {
    assert.match(ubuntuJob(), /node-version: 24\n/);
    assert.equal(pkg('.').engines?.node, '>=24');
    assert.equal(pkg('web').engines?.node, '>=24');
  });

  it('prints coverage on Ubuntu after the suites and the build, without ever failing the run', () => {
    const job = ubuntuJob();
    const step = job.slice(job.indexOf('- name: Coverage'));
    assert.ok(job.indexOf('- name: Coverage') > job.indexOf('- run: npm --prefix web run build'), 'after the build');
    assert.match(
      step,
      /^- name: Coverage.*\n {8}continue-on-error: true\n {8}run: \|\n {10}npm run test:coverage\n {10}npm run test:web:coverage\n/,
    );
    assert.ok(!windowsJob().includes('coverage'), 'Windows runs no coverage');
    // The scripts it runs exist and need no shell (tests/scripts.test.ts checks every script for shell syntax).
    assert.equal(pkg('.').scripts['test:coverage'], 'node scripts/run-tests.mjs --coverage');
    assert.equal(pkg('.').scripts['test:web:coverage'], 'npm --prefix web run test:coverage');
    assert.equal(pkg('web').scripts['test:coverage'], 'vitest run --coverage');
  });
});

describe('.github/dependabot.yml', () => {
  it('opens monthly update PRs for the bot, the dashboard, the docs site and the GitHub Actions', () => {
    for (const dir of ['"/"', '"/web"', '"/docs"']) assert.ok(dependabot.includes(`directory: ${dir}`), dir);
    assert.equal([...dependabot.matchAll(/interval: monthly/g)].length, 4);
    assert.equal([...dependabot.matchAll(/package-ecosystem: npm/g)].length, 3);
    assert.match(dependabot, /package-ecosystem: github-actions/);
  });

  it('keeps the docs site packages in one grouped PR', () => {
    const docs = dependabot.slice(dependabot.indexOf('directory: "/docs"'), dependabot.indexOf('github-actions'));
    assert.match(docs, /docs-site:\n {8}patterns: \["\*"\]/);
  });

  it('groups packages that must move together into one PR (react with react-dom, vitest with its plugins)', () => {
    const web = dependabot.slice(dependabot.indexOf('directory: "/web"'), dependabot.indexOf('github-actions'));
    assert.match(web, /react:\n {8}patterns: \[.*"react".*"react-dom".*\]/);
    assert.match(web, /vitest:\n {8}patterns: \[.*"vitest".*"@vitest\/\*".*\]/);
    assert.match(web, /tailwind:\n {8}patterns: \[.*"tailwindcss".*"@tailwindcss\/\*".*\]/);
  });
});
