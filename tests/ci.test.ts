import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The GitHub Actions workflow: least-privilege token, one run per branch, and the triggers it always had.
const workflow = readFileSync(join(import.meta.dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');

describe('.github/workflows/test.yml', () => {
  it('runs on push and pull_request', () => {
    assert.match(workflow, /^on:\n {2}push:\n {2}pull_request:\n/m);
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

  it('runs install, Biome, typecheck and the database-free tests on Windows', () => {
    const job = workflow.slice(workflow.indexOf('\n  portable:'));
    assert.match(job, /os: \[windows-latest\]/);
    for (const step of ['npm ci', 'npm ci --prefix web', 'npx biome ci .', 'npm run typecheck'])
      assert.ok(job.includes(`- run: ${step}\n`), step);
    const files = [...job.matchAll(/tests\/[\w-]+\.test\.ts/g)].map((m) => m[0]);
    for (const f of ['tests/notify.test.ts', 'tests/backup.test.ts', 'tests/daily.test.ts', 'tests/scripts.test.ts'])
      assert.ok(files.includes(f), f);
    // None of them may need the database: no import of src/db.ts or pg.
    for (const f of files)
      assert.doesNotMatch(readFileSync(join(import.meta.dirname, '..', f), 'utf8'), /^import .*(src\/db\.ts|'pg');$/m, f);
  });
});
