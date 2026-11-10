import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveApi, resolveClaude } from '../ai-providers.ts';
import { resolveChrome } from '../cv/chrome.ts';
import { checkDatabase, type DbState } from '../db-check.ts';
import { buildProfile, profileGaps } from '../profile.ts';
import { applicantFile, configFile, masterFile, ROOT, validate } from '../settings.ts';

// `npm run bot -- doctor`: checks a setup end to end (Node, packages, settings, CV, database, PDF renderer, AI) and
// says how to fix each problem. It changes nothing. Every outside dependency is injectable, so tests run it anywhere.

export type Level = 'ok' | 'warn' | 'fail';
export type Check = { name: string; level: Level; detail: string; fix?: string };

export type DoctorDeps = {
  root: string;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
  exists: (p: string) => boolean;
  read: (p: string) => string;
  files: { config: string; applicant: string; master: string };
  database: (url: string) => Promise<DbState>;
  chrome: (chromePath: string | undefined) => string | null | undefined;
  claude: (claudePath: string | undefined) => string;
};

const defaults = (): DoctorDeps => ({
  root: ROOT,
  nodeVersion: process.versions.node,
  env: process.env,
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  files: { config: configFile(), applicant: applicantFile(), master: masterFile() },
  database: checkDatabase,
  chrome: (p) => resolveChrome(p),
  claude: (p) => resolveClaude(p),
});

const INSTALL = 'npm install && npm --prefix web install';

/** Parses a JSON file: the value, or why it could not be read. */
function json(d: DoctorDeps, file: string): { value?: any; error?: string } {
  if (!d.exists(file)) return { error: 'missing' };
  try {
    return { value: JSON.parse(d.read(file)) };
  } catch (e) {
    return { error: `not valid JSON (${(e as Error).message})` };
  }
}

export async function runChecks(deps: Partial<DoctorDeps> = {}): Promise<Check[]> {
  const d = { ...defaults(), ...deps };
  const out: Check[] = [];
  const add = (name: string, level: Level, detail: string, fix?: string) => out.push({ name, level, detail, fix });

  const major = Number(d.nodeVersion.split('.')[0]);
  if (major >= 24) add('Node.js', 'ok', `v${d.nodeVersion}`);
  else add('Node.js', 'fail', `v${d.nodeVersion}, needs 24 or newer`, 'install Node.js 24+ (your install guide, step 1)');

  const bot = d.exists(join(d.root, 'node_modules', 'pg'));
  const web = d.exists(join(d.root, 'web', 'node_modules', 'next'));
  if (bot && web) add('Packages', 'ok', 'bot and dashboard installed');
  else add('Packages', 'fail', `${bot ? '' : 'bot '}${!bot && !web ? 'and ' : ''}${web ? '' : 'dashboard '}packages missing`, INSTALL);

  const cfgFile = json(d, d.files.config);
  const cfg = cfgFile.value;
  if (cfgFile.error) add('config.json', 'fail', cfgFile.error, 'npm run bot -- setup');
  else {
    const res = validate('config', cfg);
    if (res.ok)
      add('config.json', 'ok', `${Object.keys(cfg.countries ?? {}).join(', ') || 'no countries'}${cfg.remote?.enabled ? ' + remote' : ''}`);
    else
      add(
        'config.json',
        'fail',
        res.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
        'npm run bot -- settings:check --kind config --file config.json',
      );
  }

  const masterFile = json(d, d.files.master);
  const cv = masterFile.value;
  if (masterFile.error)
    add(
      'Your CV (cv/master.json)',
      'fail',
      masterFile.error,
      'npm run bot -- setup (offers to start it from the example), then put in your CV',
    );
  else if (cv?.name === 'Jane Doe')
    add('Your CV (cv/master.json)', 'warn', 'still the example CV (Jane Doe)', 'replace it with your own CV (docs/your-cv-and-profile.md)');
  else add('Your CV (cv/master.json)', 'ok', String(cv?.name ?? 'no name'));

  const appFile = json(d, d.files.applicant);
  if (appFile.error) add('Your profile (cv/applicant.json)', 'fail', appFile.error, 'npm run bot -- setup');
  else {
    const gaps = profileGaps(buildProfile(appFile.value ?? {}, cv ?? {}));
    if (gaps.length)
      add(
        'Your profile (cv/applicant.json)',
        'warn',
        `missing: ${gaps.join(', ')}`,
        'npm run bot -- setup, or the dashboard Settings page',
      );
    else add('Your profile (cv/applicant.json)', 'ok', 'complete');
  }

  const url = d.env.DATABASE_URL;
  if (!url) add('Database', 'fail', 'DATABASE_URL is not set in .env', 'npm run bot -- setup (offers to write .env)');
  else {
    const db = await d.database(url);
    if (db.state === 'ok') add('Database', 'ok', 'reachable');
    else if (db.state === 'missing') add('Database', 'fail', `"${db.name}" does not exist`, 'npm run bot -- setup (offers to create it)');
    else add('Database', 'fail', db.message, 'start PostgreSQL (your install guide, step 2)');
  }
  if (d.exists(join(d.root, 'web', '.env.local'))) add('Dashboard settings (web/.env.local)', 'ok', 'present');
  else
    add(
      'Dashboard settings (web/.env.local)',
      'fail',
      'missing: the dashboard has no DATABASE_URL',
      'npm run bot -- setup (offers to write it)',
    );

  const chrome = d.chrome(cfg?.chromePath);
  if (chrome) add('PDF renderer (Chrome)', 'ok', chrome);
  else add('PDF renderer (Chrome)', 'fail', 'no Chrome or headless shell found', 'npx playwright-core install chromium-headless-shell');

  const ai = cfg?.ai ?? {};
  if (ai.enabled === false) add('AI', 'ok', 'off (config.json ai.enabled)');
  else if (ai.provider && ai.provider !== 'claude-cli') {
    try {
      const t = resolveApi(ai, d.env);
      add('AI', 'ok', `${t.name} API, key in ${t.keyEnv}`);
    } catch (e) {
      add('AI', 'fail', (e as Error).message, 'docs/ai.md');
    }
  } else {
    const claude = d.claude(ai.claudePath);
    if (/[\\/]/.test(claude) && d.exists(claude)) add('AI', 'ok', `Claude CLI at ${claude}`);
    else add('AI', 'fail', `Claude CLI "${claude}" not found`, 'install Claude Code and sign in (docs/ai.md), or set ai.claudePath');
  }
  return out;
}

const MARK: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗' };

/** doctor: prints each check; exits 1 when one fails (warnings alone do not). */
export async function doctor() {
  const checks = await runChecks();
  for (const c of checks) console.log(`${MARK[c.level]} ${c.name}: ${c.detail}${c.fix && c.level !== 'ok' ? `\n    fix: ${c.fix}` : ''}`);
  const failed = checks.filter((c) => c.level === 'fail').length;
  const warned = checks.filter((c) => c.level === 'warn').length;
  console.log(
    failed
      ? `\n${failed} problem${failed > 1 ? 's' : ''} to fix.`
      : `\nAll set${warned ? `, ${warned} thing${warned > 1 ? 's' : ''} to look at` : ''}.`,
  );
  if (failed) process.exitCode = 1;
}
