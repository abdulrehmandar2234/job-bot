// `npm install` runs this ("prepare"): points git at .githooks, so the Biome pre-commit hook runs. Works on every OS
// (the old `git config ... || true` needed a POSIX shell). Outside a git checkout, or without git, it does nothing.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

spawnSync('git', ['config', 'core.hooksPath', '.githooks'], {
  cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  stdio: 'ignore',
  windowsHide: true,
});
