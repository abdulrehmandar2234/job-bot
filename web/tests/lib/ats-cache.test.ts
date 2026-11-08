import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AtsReport, cachedAtsReport, clearAtsCache } from '@/lib/ats-cache';
import { runBot } from '@/lib/bot';

// Only runBot is faked: lib/settings.ts still needs the real BOT_ROOT (it roots the master CV path).
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<typeof import('@/lib/bot')>()), runBot: vi.fn() }));

const report = (label = 'laravel-v2'): AtsReport => ({
  label,
  source: 'prepared',
  present: ['Laravel'],
  hiddenButTrue: ['Docker'],
  missing: ['Kubernetes'],
  total: 3,
  suggestion: null,
});

// A master CV of our own, so the tests control its mtime (the cache's invalidation signal).
const dir = mkdtempSync(join(tmpdir(), 'ats-cache-'));
const master = join(dir, 'master.json');
const originalMaster = process.env.JOB_BOT_MASTER;
const T0 = new Date('2026-11-01T10:00:00Z');

beforeEach(() => {
  process.env.JOB_BOT_MASTER = master;
  writeFileSync(master, '{}');
  utimesSync(master, T0, T0);
  clearAtsCache();
  vi.mocked(runBot).mockReset().mockResolvedValue(JSON.stringify(report()));
});

afterAll(() => {
  process.env.JOB_BOT_MASTER = originalMaster;
  rmSync(dir, { recursive: true, force: true });
});

describe('cachedAtsReport', () => {
  it('spawns the bot once and serves the second call for the same job and version from the cache', async () => {
    const first = await cachedAtsReport('greenhouse:acme:1', 'laravel-v2');
    const second = await cachedAtsReport('greenhouse:acme:1', 'laravel-v2');
    expect(runBot).toHaveBeenCalledTimes(1);
    expect(runBot).toHaveBeenCalledWith(['ats', 'greenhouse:acme:1', '--json']);
    expect(first).toEqual(report());
    expect(second).toEqual(first);
  });

  it('re-runs for another job', async () => {
    await cachedAtsReport('greenhouse:acme:1', 'laravel-v2');
    await cachedAtsReport('greenhouse:acme:2', 'laravel-v2');
    expect(runBot).toHaveBeenCalledTimes(2);
  });

  it("re-runs when the job's CV version changes (a newly prepared CV)", async () => {
    await cachedAtsReport('greenhouse:acme:1', 'laravel-v2');
    await cachedAtsReport('greenhouse:acme:1', 'laravel-v3');
    expect(runBot).toHaveBeenCalledTimes(2);
  });

  it('re-runs when the master CV is edited (its mtime changes)', async () => {
    await cachedAtsReport('greenhouse:acme:1', 'laravel-v2');
    utimesSync(master, T0, new Date(T0.getTime() + 60_000));
    await cachedAtsReport('greenhouse:acme:1', 'laravel-v2');
    expect(runBot).toHaveBeenCalledTimes(2);
  });

  it('still caches without a master CV file', async () => {
    rmSync(master);
    await cachedAtsReport('greenhouse:acme:1', null);
    await cachedAtsReport('greenhouse:acme:1', null);
    expect(runBot).toHaveBeenCalledTimes(1);
  });

  it('never caches a failed run or a non-JSON answer', async () => {
    vi.mocked(runBot).mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce('Not found\n');
    await expect(cachedAtsReport('greenhouse:acme:1', 'laravel-v2')).rejects.toThrow('spawn failed');
    await expect(cachedAtsReport('greenhouse:acme:1', 'laravel-v2')).rejects.toThrow(); // "Not found" is not a report
    const ok = await cachedAtsReport('greenhouse:acme:1', 'laravel-v2'); // the default mock again
    expect(ok).toEqual(report());
    expect(runBot).toHaveBeenCalledTimes(3);
  });

  it('clears itself when full instead of growing without bound', async () => {
    for (let i = 0; i < 50; i++) await cachedAtsReport(`job:${i}`, null);
    expect(runBot).toHaveBeenCalledTimes(50);
    await cachedAtsReport('job:0', null); // still cached: the 50th entry filled the cache without tipping it over
    expect(runBot).toHaveBeenCalledTimes(50);
    await cachedAtsReport('job:over', null); // the 51st entry clears the cache first
    await cachedAtsReport('job:over', null); // and is itself cached again
    expect(runBot).toHaveBeenCalledTimes(51);
    await cachedAtsReport('job:0', null); // the cleared entry re-runs
    expect(runBot).toHaveBeenCalledTimes(52);
  });
});
