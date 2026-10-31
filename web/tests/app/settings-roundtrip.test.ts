import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveApplicant, saveConfig } from '@/app/settings/actions';
import { BOT_ROOT } from '@/lib/bot';
import { CONFIG_FIELDS, get, type Json } from '@/lib/settings-form';

// The real CLI (settings:save, rescore) on temp copies of the settings files, with the bot's test database.
vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// The re-score after a config save is a background task (tests/app/settings-actions.test.ts); no worker here.
vi.mock('@/lib/tasks', () => ({ enqueueTask: vi.fn() }));

const BOT_DB_URL = process.env.DATABASE_URL!.replace(/\/job_bot_test(_[a-z0-9]+)?$/, '/job_bot_test_bot$1');
const REAL_CONFIG = join(BOT_ROOT, 'config.default.json');
const realConfigText = readFileSync(REAL_CONFIG, 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'job-bot-web-settings-rt-'));
const CONFIG_FILE = join(dir, 'config.json');
const APPLICANT_FILE = join(dir, 'applicant.json');
const tempFiles = () => (existsSync(join(BOT_ROOT, 'data', 'settings')) ? readdirSync(join(BOT_ROOT, 'data', 'settings')) : []);
const startTemps = tempFiles();

/** The config form as the page would post it, unchanged, plus overrides. */
function configForm(cfg: Json, over: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [name, type] of Object.entries(CONFIG_FIELDS)) {
    const v = get(cfg, name);
    if (type === 'bool') {
      if (v === true) fd.set(name, 'on');
    } else fd.set(name, Array.isArray(v) ? v.join('\n') : String(v ?? ''));
  }
  (cfg.companies as Json[]).forEach((c, i) => {
    fd.set(`companies[${i}].orig`, String(i));
    for (const k of ['name', 'ats', 'token']) fd.set(`companies[${i}].${k}`, String(c[k]));
  });
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  expect(BOT_DB_URL).toMatch(/\/job_bot_test_bot(_[a-z0-9]+)?$/);
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...JSON.parse(realConfigText), futureKey: { keep: true } }, null, 2));
  rmSync(APPLICANT_FILE, { force: true });
  vi.stubEnv('JOB_BOT_CONFIG', CONFIG_FILE);
  vi.stubEnv('JOB_BOT_APPLICANT', APPLICANT_FILE);
  vi.stubEnv('DATABASE_URL', BOT_DB_URL);
  vi.stubEnv('JOB_BOT_CLAUDE', 'tests/fixtures/fake-claude.mjs');
});
afterEach(() => {
  vi.unstubAllEnvs();
  // Never the real files, and no temp files left behind.
  expect(readFileSync(REAL_CONFIG, 'utf8')).toBe(realConfigText);
  expect(tempFiles()).toEqual(startTemps);
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settings round-trip through the CLI', () => {
  it('saves a config form edit, keeps unknown keys and queues a re-score', async () => {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    const res = await saveConfig(null, configForm(cfg, { minScore: '61' }));
    expect(res).toMatchObject({ ok: true, message: 'Saved. Re-scoring jobs in the background.' });
    const after = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    expect(after).toEqual({ ...cfg, minScore: 61 });
    expect(after.futureKey).toEqual({ keep: true });
  }, 60_000);

  it('saves an AI provider and its models through the bot validator, and rejects a bad base URL', async () => {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    const res = await saveConfig(
      null,
      configForm(cfg, { 'ai.provider': 'api', 'ai.api.preset': 'gemini', 'ai.api.letterModel': 'gemini-x' }),
    );
    expect(res).toMatchObject({ ok: true });
    const after = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    expect(after).toEqual({ ...cfg, ai: { ...cfg.ai, provider: 'api', api: { preset: 'gemini', letterModel: 'gemini-x' } } });

    const bad = await saveConfig(null, configForm(after, { 'ai.api.baseUrl': 'not a url', 'ai.api.preset': 'gemini' }));
    expect(bad).toMatchObject({ ok: false, errors: [expect.objectContaining({ path: 'ai.api.baseUrl' })] });
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))).toEqual(after);
  }, 60_000);

  it('saves a config without adzuna (empty Adzuna fields) without adding an invalid section', async () => {
    const { adzuna: _, ...cfg } = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Json;
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    const empty = { 'adzuna.countries': '', 'adzuna.keywords': '', 'adzuna.pagesPerSearch': '' };
    expect(await saveConfig(null, configForm(cfg, empty))).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))).toEqual(cfg);

    const res = await saveConfig(null, configForm(cfg, { ...empty, 'adzuna.countries': 'nl\nde', 'adzuna.pagesPerSearch': '1' }));
    expect(res).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')).adzuna).toEqual({ countries: ['nl', 'de'], pagesPerSearch: 1 });
  }, 60_000);

  it('returns field errors from the validator and leaves the file alone', async () => {
    const before = readFileSync(CONFIG_FILE, 'utf8');
    const cfg = JSON.parse(before);
    const res = await saveConfig(null, configForm(cfg, { 'companies[1].ats': 'workday-nope', maxAgeDays: '-1' }));
    expect(res!.ok).toBe(false);
    expect(res!.errors.map((e) => e.path).sort()).toEqual(['companies[1].ats', 'maxAgeDays']);
    expect(readFileSync(CONFIG_FILE, 'utf8')).toBe(before);
  }, 60_000);

  it('creates applicant.json from the example with empty fields as null', async () => {
    const fd = new FormData();
    fd.set('nationality', 'Pakistani');
    fd.set('noticePeriod', '');
    fd.set('expectedSalary.AE', '25,000 AED');
    expect(await saveApplicant(null, fd)).toEqual({ ok: true, message: 'Saved.', errors: [] });
    const saved = JSON.parse(readFileSync(APPLICANT_FILE, 'utf8'));
    expect(saved).toMatchObject({
      _help: expect.any(String),
      nationality: 'Pakistani',
      noticePeriod: null,
      currentLocation: null,
      expectedSalary: { AE: '25,000 AED', SA: null, NL: null, remote: null },
      other: {},
    });
  }, 60_000);
});
