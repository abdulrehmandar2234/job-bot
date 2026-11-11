import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OWNER_MASTER } from './helpers.ts';
import { inDocker, runChecks, type Check, type DoctorDeps } from '../src/commands/doctor.ts';

// `bot doctor` checks a setup and says how to fix it. Every outside dependency is faked: no database, Chrome or AI.

const ROOT = join(import.meta.dirname, '..');
const run = promisify(execFile);
const CONFIG = readFileSync(join(ROOT, 'config.default.json'), 'utf8');
const APPLICANT = readFileSync(join(import.meta.dirname, 'fixtures', 'applicant-owner.json'), 'utf8');
const MASTER = readFileSync(OWNER_MASTER, 'utf8');
const JANE = readFileSync(join(ROOT, 'cv', 'master.example.json'), 'utf8');
const files = { config: '/x/config.json', applicant: '/x/cv/applicant.json', master: '/x/cv/master.json' };

/** A healthy setup; `over` changes one thing at a time. */
function deps(over: Partial<DoctorDeps> & { contents?: Record<string, string | undefined>; missing?: string[] } = {}): Partial<DoctorDeps> {
  const contents: Record<string, string | undefined> = {
    [files.config]: CONFIG,
    [files.applicant]: APPLICANT,
    [files.master]: MASTER,
    ...over.contents,
  };
  const present = (p: string) => !over.missing?.some((m) => p.endsWith(m));
  return {
    root: '/x',
    nodeVersion: '24.3.0',
    env: { DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/job_bot' },
    files,
    exists: (p) => present(p) && (p in contents ? contents[p] !== undefined : true),
    read: (p) => contents[p] ?? '',
    database: async () => ({ state: 'ok' }),
    chrome: () => '/opt/chrome',
    claude: () => '/home/me/.local/bin/claude',
    ...over,
  };
}
const byName = (checks: Check[], name: string) => checks.find((c) => c.name.startsWith(name))!;

describe('doctor in the Docker image (TALAASH_DOCKER=1)', () => {
  it('says each fix the Docker way: compose exec for bot commands, an API key instead of the Claude CLI, a rebuild for Chrome', async () => {
    const checks = await runChecks(
      deps({
        env: { DATABASE_URL: 'postgres://postgres:talaash@db:5432/job_bot', TALAASH_DOCKER: '1' },
        contents: { [files.master]: undefined, [files.applicant]: undefined },
        chrome: () => null,
        claude: () => 'claude',
      }),
    );
    assert.equal(
      byName(checks, 'Your CV').fix,
      'docker compose exec app bot setup (offers to start it from the example), then put in your CV',
    );
    assert.equal(byName(checks, 'Your profile').fix, 'docker compose exec app bot setup');
    assert.equal(byName(checks, 'PDF renderer').fix, 'rebuild the image: docker compose up -d --build');
    assert.equal(byName(checks, 'AI').fix, 'the Docker image has no Claude CLI: use an API key or Ollama (docs/install/docker.md#ai)');
    assert.ok(checks.every((c) => !c.fix?.includes('npm run bot')));
  });

  it('leaves passing checks and fixes outside Docker alone', async () => {
    assert.deepEqual(inDocker({ name: 'Database', level: 'ok', detail: 'reachable' }), {
      name: 'Database',
      level: 'ok',
      detail: 'reachable',
    });
    const outside = await runChecks(deps({ contents: { [files.master]: undefined } }));
    assert.match(byName(outside, 'Your CV').fix ?? '', /^npm run bot -- setup/);
  });
});

describe('doctor', () => {
  it('a healthy setup passes every check', async () => {
    const checks = await runChecks(deps());
    assert.deepEqual(
      checks.filter((c) => c.level !== 'ok').map((c) => `${c.name}: ${c.detail}`),
      [],
    );
    assert.deepEqual(
      checks.map((c) => c.name),
      [
        'Node.js',
        'Packages',
        'config.json',
        'Your CV (cv/master.json)',
        'Your profile (cv/applicant.json)',
        'Database',
        'Dashboard settings (web/.env.local)',
        'PDF renderer (Chrome)',
        'AI',
      ],
    );
  });

  it('names each problem with its fix', async () => {
    const checks = await runChecks(
      deps({
        nodeVersion: '22.1.0',
        missing: ['web/node_modules/next', 'web/.env.local'],
        contents: { [files.master]: undefined },
        database: async () => ({ state: 'missing', name: 'job_bot' }),
        chrome: () => null,
        claude: () => 'claude',
      }),
    );
    assert.equal(byName(checks, 'Node.js').level, 'fail');
    assert.match(byName(checks, 'Packages').fix!, /npm --prefix web install/);
    assert.match(byName(checks, 'Packages').detail, /dashboard packages missing/);
    assert.equal(byName(checks, 'Your CV').detail, 'missing');
    assert.match(byName(checks, 'Your CV').fix!, /setup/);
    assert.deepEqual(
      [byName(checks, 'Database').detail, byName(checks, 'Database').fix],
      ['"job_bot" does not exist', 'npm run bot -- setup (offers to create it)'],
    );
    assert.equal(byName(checks, 'Dashboard settings').level, 'fail');
    assert.match(byName(checks, 'PDF renderer').fix!, /playwright-core install chromium-headless-shell/);
    assert.match(byName(checks, 'AI').detail, /Claude CLI "claude" not found/);
  });

  it('warns about the example CV and an incomplete profile, and fails a broken config.json', async () => {
    const checks = await runChecks(deps({ contents: { [files.master]: JANE, [files.applicant]: '{}', [files.config]: '{ broken' } }));
    assert.deepEqual([byName(checks, 'Your CV').level, byName(checks, 'Your CV').detail], ['warn', 'still the example CV (Jane Doe)']);
    assert.equal(byName(checks, 'Your profile').level, 'warn');
    assert.match(byName(checks, 'Your profile').detail, /^missing: /);
    assert.equal(byName(checks, 'config.json').level, 'fail');
    assert.match(byName(checks, 'config.json').detail, /not valid JSON/);
  });

  it('checks the database only with a DATABASE_URL, and reports an unreachable server', async () => {
    let asked = 0;
    const none = await runChecks(
      deps({
        env: {},
        database: async () => {
          asked++;
          return { state: 'ok' };
        },
      }),
    );
    assert.equal(asked, 0);
    assert.match(byName(none, 'Database').detail, /DATABASE_URL is not set/);
    const down = await runChecks(
      deps({ database: async () => ({ state: 'error', message: 'nothing answers at 127.0.0.1:5432: is PostgreSQL running?' }) }),
    );
    assert.match(byName(down, 'Database').detail, /is PostgreSQL running/);
  });

  it('the API provider needs its key; AI off needs nothing', async () => {
    const api = JSON.stringify({ ...JSON.parse(CONFIG), ai: { ...JSON.parse(CONFIG).ai, provider: 'api' } });
    const noKey = await runChecks(deps({ contents: { [files.config]: api } }));
    assert.equal(byName(noKey, 'AI').level, 'fail');
    assert.match(byName(noKey, 'AI').detail, /AI_API_KEY/);
    const withKey = await runChecks(
      deps({ contents: { [files.config]: api }, env: { DATABASE_URL: 'postgres://x@h/db', AI_API_KEY: 'sk-ant-test' } }),
    );
    assert.equal(byName(withKey, 'AI').level, 'ok');
    assert.doesNotMatch(byName(withKey, 'AI').detail, /sk-ant-test/, 'never prints the key');
    const off = JSON.stringify({ ...JSON.parse(CONFIG), ai: { ...JSON.parse(CONFIG).ai, enabled: false } });
    assert.equal(byName(await runChecks(deps({ contents: { [files.config]: off }, claude: () => 'claude' })), 'AI').level, 'ok');
  });

  it('runs as `bot doctor` without a database or a valid config, and exits 1 on a problem', async () => {
    const res = await run(process.execPath, ['--no-warnings', join(ROOT, 'src', 'cli.ts'), 'doctor'], {
      env: { ...process.env, DATABASE_URL: '', JOB_BOT_CONFIG: '/nonexistent/config.json' },
    }).then(
      () => ({ code: 0, stdout: '' }),
      (e: { code: number; stdout: string }) => e,
    );
    assert.equal(res.code, 1);
    assert.match(res.stdout, /^✗ Database: DATABASE_URL is not set in \.env\n {4}fix: /m);
    assert.match(res.stdout, /problems? to fix\.$/m);
  });
});
