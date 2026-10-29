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
