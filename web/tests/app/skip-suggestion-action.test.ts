import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoleExclude, blockCompany } from '@/app/settings/actions';
import { BOT_ROOT, runBot, spawnBot } from '@/lib/bot';
import { pool } from '@/lib/db';
import { MIN_SKIPS } from '@/lib/skip-insights';
import { cleanupDb, closeDb, ensureSchema, insertJob } from '../helpers/db';

vi.mock('next/cache', () => ({ refresh: vi.fn() }));
// Keep the real module, but never spawn the bot CLI and write temp files into a temp "bot root".
vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return {
    ...(await importOriginal<typeof import('@/lib/bot')>()),
    BOT_ROOT: mkdtempSync(j(tmpdir(), 'talaash-web-skip-actions-')),
    runBot: vi.fn(),
    spawnBot: vi.fn(),
  };
});

const bot = vi.mocked(runBot);
const dir = mkdtempSync(join(tmpdir(), 'talaash-web-skip-config-'));
const CONFIG_FILE = join(dir, 'config.json');
const CONFIG = { minScore: 45, roleExclude: 'golang', futureKey: 'kept' };
const form = (pattern?: string) => {
  const fd = new FormData();
  if (pattern !== undefined) fd.set('pattern', pattern);
  return fd;
};

/** What the action handed to settings:save, read while the mocked CLI "runs". */
let saved: { args: string[]; json: Record<string, unknown> }[] = [];

beforeAll(ensureSchema);
beforeEach(async () => {
  await cleanupDb();
  vi.clearAllMocks();
  saved = [];
  writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG));
  vi.stubEnv('JOB_BOT_CONFIG', CONFIG_FILE);
  bot.mockImplementation(async (args) => {
    saved.push({ args, json: JSON.parse(readFileSync(args[args.indexOf('--file') + 1], 'utf8')) });
    return '{"ok":true}';
  });
  // Enough jobs skipped for seniority with "principal" in the title, and one kept job without it.
  for (let i = 0; i < MIN_SKIPS; i++) {
    const id = await insertJob({ id: `sa-${i}`, title: `Principal Engineer ${i}`, status: 'skipped' });
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status, reason) VALUES ($1, 'new', 'skipped', 'seniority')`, [id]);
  }
  await insertJob({ id: 'sa-kept', title: 'Senior Engineer' });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await closeDb();
  rmSync(BOT_ROOT, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('addRoleExclude', () => {
  it('appends a current suggestion to roleExclude through settings:save, keeping the other keys, then queues a re-score', async () => {
    const res = await addRoleExclude(null, form('\\bprincipal\\b'));
    expect(res).toEqual({ ok: true, message: 'Saved. Re-scoring jobs in the background.', errors: [] });
    expect(saved).toHaveLength(1);
    expect(saved[0].args.slice(0, 3)).toEqual(['settings:save', '--kind', 'config']);
    expect(saved[0].json).toEqual({ ...CONFIG, roleExclude: 'golang|\\bprincipal\\b' });
    expect(() => new RegExp(saved[0].json.roleExclude as string)).not.toThrow();
    // The re-score is a queued background task with its own worker, not a blocking CLI call in the request.
    expect(bot).toHaveBeenCalledOnce();
    const { rows } = await pool.query(`SELECT id, kind, job_id, status FROM tasks WHERE kind = 'rescore'`);
    expect(rows).toEqual([{ id: expect.any(Number), kind: 'rescore', job_id: null, status: 'queued' }]);
    expect(spawnBot).toHaveBeenCalledExactlyOnceWith(['task:run', String(rows[0].id)]);
    expect(refresh).toHaveBeenCalledOnce();
    // The action never writes config.json itself; the (mocked) CLI is the only writer.
    expect(JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))).toEqual(CONFIG);
  });

  it('refuses any pattern that is not a current suggestion, without running the bot', async () => {
    for (const p of [undefined, '', '.*', '\\bstaff\\b', '\\bsenior\\b']) {
      expect(await addRoleExclude(null, form(p)), String(p)).toEqual({
        ok: false,
        message: 'That suggestion is no longer valid.',
        errors: [],
      });
    }
    // Once roleExclude covers the word, the suggestion is gone.
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...CONFIG, roleExclude: 'principal' }));
    expect(await addRoleExclude(null, form('\\bprincipal\\b'))).toMatchObject({ ok: false });
    expect(bot).not.toHaveBeenCalled();
    expect(spawnBot).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refuses while config.json cannot be parsed', async () => {
    writeFileSync(CONFIG_FILE, '{ broken');
    expect(await addRoleExclude(null, form('\\bprincipal\\b'))).toMatchObject({
      ok: false,
      message: expect.stringContaining('cannot be read'),
    });
    expect(bot).not.toHaveBeenCalled();
  });
});

describe('blockCompany', () => {
  const job = (id?: string) => {
    const fd = new FormData();
    if (id !== undefined) fd.set('id', id);
    return fd;
  };

  it("adds the job's company to blockedCompanies through settings:save, keeping the other keys, then queues a re-score", async () => {
    const id = await insertJob({ id: 'block-1', company: ' Acme Inc. ' });
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...CONFIG, blockedCompanies: ['Globex'] }));
    const res = await blockCompany(null, job(id));
    expect(res).toEqual({ ok: true, message: 'Acme Inc. is hidden. Saved. Re-scoring jobs in the background.', errors: [] });
    expect(saved).toHaveLength(1);
    expect(saved[0].json).toEqual({ ...CONFIG, blockedCompanies: ['Globex', 'Acme Inc.'] });
    const { rows } = await pool.query(`SELECT kind FROM tasks WHERE kind = 'rescore'`);
    expect(rows).toHaveLength(1);
  });

  it('refuses a company already hidden under another spelling, and a missing job, without running the bot', async () => {
    const id = await insertJob({ id: 'block-2', company: 'ACME' });
    writeFileSync(CONFIG_FILE, JSON.stringify({ ...CONFIG, blockedCompanies: ['Acme Inc.'] }));
    expect(await blockCompany(null, job(id))).toEqual({
      ok: false,
      message: 'ACME is already hidden (as "Acme Inc." under Settings, Companies to hide).',
      errors: [],
    });
    for (const fd of [job(), job('webtest:nope')])
      expect(await blockCompany(null, fd)).toEqual({ ok: false, message: 'That job no longer exists.', errors: [] });
    expect(bot).not.toHaveBeenCalled();
  });
});
