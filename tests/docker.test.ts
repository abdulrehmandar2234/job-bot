import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The Docker setup (docs/install/docker.md). .github/workflows/docker.yml builds and runs it for real; these checks
// run with every test run and keep its promises from drifting: nothing personal in the image, the dashboard only on
// this computer, settings files moved by variables (they are saved by rename, which would break a symlink).
const ROOT = join(import.meta.dirname, '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const ignore = read('.dockerignore')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

describe('Docker setup', () => {
  it('.dockerignore keeps personal files, secrets and local installs out of the image', () => {
    for (const p of [
      'config.json',
      'cv/applicant.json',
      'cv/master.json',
      'cv/default',
      'cv/original',
      'cv/versions',
      'applications',
      'data',
      '.env',
      '.env.*',
      'web/.env*.local',
      'talaash-home',
      '**/node_modules',
      '.git',
    ])
      assert.ok(ignore.includes(p), p);
  });

  it('every gitignored personal path is dockerignored too', () => {
    const personal = read('.gitignore')
      .split('# Personal data')[1]
      .split('\n')
      .slice(1) // the rest of the heading line
      .map((l) => l.trim().replace(/\/$/, ''))
      .filter((l) => l && !l.startsWith('#'));
    assert.ok(personal.includes('cv/master.json'));
    for (const p of personal) assert.ok(ignore.includes(p), p);
  });

  it('moves the settings files into /app/home with variables, and only folders with symlinks', () => {
    for (const [name, value] of [
      ['JOB_BOT_CONFIG', '/app/home/config.json'],
      ['JOB_BOT_APPLICANT', '/app/home/cv/applicant.json'],
      ['JOB_BOT_MASTER', '/app/home/cv/master.json'],
      ['JOB_BOT_DATA_DIR', '/app/home/data'],
      ['JOB_BOT_ENV_FILE', '/app/home/.env'],
    ])
      assert.match(dockerfile, new RegExp(`${name}=${value.replace(/\./g, '\\.')}\\b`), name);
    const links = [...dockerfile.matchAll(/ln -s (\S+) (\S+)/g)].map((m) => m[2]);
    assert.deepEqual(links.sort(), [
      '/app/.env',
      '/app/applications',
      '/app/cv/default',
      '/app/cv/original',
      '/app/cv/versions',
      '/app/data',
      '/app/web/.env.local',
    ]);
    assert.ok(!links.some((l) => /config\.json|master\.json|applicant\.json/.test(l)), 'no symlinked settings file');
  });

  it('publishes the dashboard on 127.0.0.1 only, and passes TZ for dailyTime', () => {
    assert.match(compose, /- "127\.0\.0\.1:\$\{TALAASH_PORT:-3100\}:3100"/);
    assert.equal([...compose.matchAll(/^\s+- "(?!127\.0\.0\.1:)\S*:\d+"/gm)].length, 0, 'no port open to the network');
    assert.match(compose, /TZ: \$\{TZ:-UTC\}/);
    assert.match(compose, /bot daily --if-due; sleep 1800/);
  });

  it('pg_dump in the image is the same major version as the database server', () => {
    const client = dockerfile.match(/postgresql-client-(\d+)/)?.[1];
    const server = compose.match(/image: postgres:(\d+)/)?.[1];
    assert.ok(client && server);
    assert.equal(client, server);
  });

  it('the bot wrapper and the entrypoint are executable and drop root to the node user', () => {
    for (const f of ['docker/bot', 'docker/entrypoint.sh']) {
      assert.ok(statSync(join(ROOT, f)).mode & 0o111, `${f} is executable`);
      assert.match(read(f), /setpriv --reuid=node --regid=node --init-groups/);
    }
    assert.match(read('docker/entrypoint.sh'), /\[ -f "\$HOME_DIR\/config\.json" \] \|\| cp \/app\/config\.default\.json/);
  });
});
