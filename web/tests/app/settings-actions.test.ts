import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveApplicant, saveConfig, saveJson } from '@/app/settings/actions';
import { BOT_ROOT, botDataDir, runBot } from '@/lib/bot';
import { enqueueTask } from '@/lib/tasks';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module, but never spawn the bot CLI and write temp files into a temp "bot root".
vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/bot')>()),
    BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-settings-actions-')),
    runBot: vi.fn(),
  };
});

// Re-scoring is queued as a background task; the queue itself is tested in tests/lib/tasks.test.ts.
vi.mock('@/lib/tasks', () => ({ enqueueTask: vi.fn() }));

const bot = vi.mocked(runBot);
const enqueue = vi.mocked(enqueueTask);
const dir = mkdtempSync(join(tmpdir(), 'job-bot-web-settings-files-'));
const CONFIG_FILE = join(dir, 'config.json');
const APPLICANT_FILE = join(dir, 'applicant.json');
const tempDir = () => join(botDataDir(), 'settings');

const CONFIG = {
  minScore: 45,
  maxAgeDays: 14,
  autoCvVersions: false,
  roleInclude: 'dev',
  roleExclude: 'x',
  futureKey: 'kept',
  ai: { enabled: true, scoreModel: 'haiku', letterModel: 'sonnet', maxScorePerRun: 80 },
  linkedin: { enabled: true, keywords: ['php'], locations: [], remoteFrom: 'Pakistan', pagesPerSearch: 2 },
  remote: { enabled: true, boards: [], himalayasQueries: [], allow: 'a', deny: 'd', flag: 'f' },
  countries: {},
  companies: [{ name: 'A', ats: 'lever', token: 'a', indName: 'A B.V.' }],
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};
const configForm = () =>
  form({
    minScore: '60',
    maxAgeDays: '14',
    roleInclude: 'dev',
    roleExclude: 'x',
    'linkedin.keywords': 'php',
    'linkedin.remoteFrom': 'Pakistan',
    'linkedin.pagesPerSearch': '2',
    'remote.allow': 'a',
    'remote.deny': 'd',
    'remote.flag': 'f',
    'ai.scoreModel': 'haiku',
    'ai.letterModel': 'sonnet',
    'ai.maxScorePerRun': '80',
    'companies[0].orig': '0',
    'companies[0].name': 'A',
    'companies[0].ats': 'nope',
    'companies[0].token': 'a',
  });

/** What the action handed to settings:save, read while the mocked CLI "runs". */
let saved: { args: string[]; json: unknown; file: string }[] = [];
const cliSays = (stdout: string, exitCode = 0) =>
  bot.mockImplementationOnce(async (args) => {
    const file = args[args.indexOf('--file') + 1];
    saved.push({ args, file, json: JSON.parse(readFileSync(file, 'utf8')) });
    if (!exitCode) return stdout;
    throw Object.assign(new Error('Command failed'), { code: exitCode, stdout });
  });

// The applicant form falls back to the bot's example file, under the (temp) bot root.
beforeAll(() => {
  mkdirSync(join(BOT_ROOT, 'cv'));
  copyFileSync(join(process.cwd(), '..', 'cv', 'applicant.example.json'), join(BOT_ROOT, 'cv', 'applicant.example.json'));
});
beforeEach(() => {
  vi.clearAllMocks();
  saved = [];
  writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG));
  rmSync(APPLICANT_FILE, { force: true });
  vi.stubEnv('JOB_BOT_CONFIG', CONFIG_FILE);
  vi.stubEnv('JOB_BOT_APPLICANT', APPLICANT_FILE);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(BOT_ROOT, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('saveConfig', () => {
  it('saves the merged config through settings:save, then queues a background re-score', async () => {
    cliSays('{"ok":true}\n');
    const res = await saveConfig(null, configForm());

    expect(res).toEqual({ ok: true, message: 'Saved. Re-scoring jobs in the background.', errors: [] });
    expect(saved[0].args).toEqual(['settings:save', '--kind', 'config', '--file', saved[0].file]);
    expect(saved[0].file.startsWith(tempDir())).toBe(true);
    expect(saved[0].json).toMatchObject({ minScore: 60, futureKey: 'kept', companies: [{ name: 'A', indName: 'A B.V.' }] });
    // The CLI only saves; the re-score never runs inside the request.
    expect(bot).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('rescore', null);
    expect(refresh).toHaveBeenCalledOnce();
    // The action never writes the real file itself; the (mocked) CLI is the only writer.
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))).toEqual(CONFIG);
    expect(readdirSync(tempDir())).toEqual([]);
  });

  it('maps the validation errors and does not re-score when the save is rejected', async () => {
    cliSays(JSON.stringify({ ok: false, errors: [{ path: 'companies[0].ats', message: 'Invalid option' }] }) + '\n', 1);
    const res = await saveConfig(null, configForm());

    expect(res).toEqual({ ok: false, message: 'Not saved: 1 problem.', errors: [{ path: 'companies[0].ats', message: 'Invalid option' }] });
    expect(bot).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(readdirSync(tempDir())).toEqual([]);
  });

  it('still reports the save when the re-score task cannot be queued', async () => {
    cliSays('{"ok":true}');
    enqueue.mockRejectedValueOnce(new Error('Could not start re-scoring jobs'));
    expect(await saveConfig(null, configForm())).toMatchObject({
      ok: true,
      message: 'Saved. Re-scoring could not start: Could not start re-scoring jobs',
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('reports a CLI crash without JSON output, and deletes the temp file', async () => {
    bot.mockRejectedValueOnce(Object.assign(new Error('Command failed: boom'), { stdout: '' }));
    expect(await saveConfig(null, configForm())).toEqual({ ok: false, message: 'Saving failed: Command failed: boom', errors: [] });
    expect(readdirSync(tempDir())).toEqual([]);
  });

  it('refuses the form while config.json cannot be parsed', async () => {
    writeFileSync(CONFIG_FILE, '{ broken');
    expect(await saveConfig(null, configForm())).toMatchObject({ ok: false, message: expect.stringContaining('Advanced: edit JSON') });
    expect(bot).not.toHaveBeenCalled();
  });
});

describe('saveApplicant', () => {
  it('starts from the example file, turns empty fields into null and does not re-score', async () => {
    cliSays('{"ok":true}');
    const res = await saveApplicant(
      null,
      form({ nationality: 'Pakistani', noticePeriod: '', 'other[0].key': 'github', 'other[0].value': 'gh' }),
    );

    expect(res).toEqual({ ok: true, message: 'Saved.', errors: [] });
    expect(saved[0].args.slice(0, 3)).toEqual(['settings:save', '--kind', 'applicant']);
    expect(saved[0].json).toMatchObject({
      _help: expect.any(String), // kept from applicant.example.json
      nationality: 'Pakistani',
      noticePeriod: null,
      currentLocation: null,
      expectedSalary: { AE: null, SA: null, NL: null, remote: null },
      other: { github: 'gh' },
    });
    expect(bot).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledOnce();
    expect(existsSync(APPLICANT_FILE)).toBe(false);
  });

  it('keeps unknown keys of an existing applicant.json', async () => {
    writeFileSync(APPLICANT_FILE, JSON.stringify({ nationality: 'X', custom: { a: 1 } }));
    cliSays('{"ok":true}');
    await saveApplicant(null, form({ nationality: 'Y' }));
    expect(saved[0].json).toMatchObject({ nationality: 'Y', custom: { a: 1 } });
  });
});

describe('saveJson', () => {
  it('passes the raw text through settings:save and re-scores only for config', async () => {
    const text = '{\n  "nationality": null\n}\n';
    cliSays('{"ok":true}');
    expect(await saveJson(null, form({ kind: 'applicant', json: text }))).toMatchObject({ ok: true, message: 'Saved.' });
    expect(bot).toHaveBeenCalledOnce();
    expect(enqueue).not.toHaveBeenCalled();

    cliSays('{"ok":true}');
    expect(await saveJson(null, form({ kind: 'config', json: JSON.stringify(CONFIG) }))).toMatchObject({
      message: 'Saved. Re-scoring jobs in the background.',
    });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith('rescore', null);
    expect(saved.map((s) => s.args[2])).toEqual(['applicant', 'config']);
  });

  it('shows invalid JSON as an error', async () => {
    bot.mockRejectedValueOnce(
      Object.assign(new Error('Command failed'), {
        stdout: '{"ok":false,"errors":[{"path":"(root)","message":"invalid JSON: x"},{"path":"minScore","message":"y"}]}\n',
      }),
    );
    expect(await saveJson(null, form({ kind: 'config', json: '{' }))).toMatchObject({ ok: false, message: 'Not saved: 2 problems.' });
    expect(refresh).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind without running the CLI', async () => {
    expect(await saveJson(null, form({ kind: '../x', json: '{}' }))).toMatchObject({ ok: false, message: 'Unknown settings kind' });
    expect(bot).not.toHaveBeenCalled();
  });
});
