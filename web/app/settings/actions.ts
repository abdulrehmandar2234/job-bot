'use server';

import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refresh } from 'next/cache';
import { BOT_ROOT, runBot } from '@/lib/bot';
import { readApplicant, readConfig } from '@/lib/settings';
import { skipInsights } from '@/lib/skip-insights';
import { mergeApplicant, mergeConfig, type SettingsError, type SettingsKind } from '@/lib/settings-form';

// The bot's `settings:save` command is the only writer and validator of config.json and cv/applicant.json.
// These actions build the new JSON, hand it over in a temp file and report the command's result.

export type SaveState = { ok: boolean; message: string; errors: SettingsError[] } | null;

const fail = (message: string, errors: SettingsError[] = []): SaveState => ({ ok: false, message, errors });

/** The `{"ok":...}` line settings:save prints, or null when the output is something else (a crash). */
function result(stdout: string): { ok: boolean; errors?: SettingsError[] } | null {
  try {
    const r = JSON.parse(stdout.trim().split('\n').at(-1) ?? '');
    return typeof r?.ok === 'boolean' ? r : null;
  } catch {
    return null;
  }
}

async function save(kind: SettingsKind, json: string): Promise<SaveState> {
  const dir = join(BOT_ROOT, 'data', 'settings');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.json`);
  await writeFile(file, json);
  let out: ReturnType<typeof result>;
  try {
    out = result(await runBot(['settings:save', '--kind', kind, '--file', file], 30_000));
  } catch (e) {
    // It exits 1 on invalid settings; the errors are still on stdout.
    out = result((e as { stdout?: string }).stdout ?? '');
    if (!out) return fail(`Saving failed: ${(e as Error).message}`);
  } finally {
    await rm(file, { force: true });
  }
  if (!out) return fail('Saving failed: unexpected output from settings:save');
  if (!out.ok) {
    const errors = out.errors ?? [];
    return fail(`Not saved: ${errors.length} problem${errors.length === 1 ? '' : 's'}.`, errors);
  }

  let message = 'Saved.';
  if (kind === 'config') {
    // Filters and patterns changed, so stored jobs are matched again.
    try {
      const n = /(\d+) jobs re-scored/.exec(await runBot(['rescore'], 120_000))?.[1];
      message += ` Re-scored ${n ?? 'the stored'} jobs.`;
    } catch (e) {
      message += ` Re-scoring failed: ${(e as Error).message}`;
    }
  }
  refresh();
  return { ok: true, message, errors: [] };
}

const unreadable = (what: string, error: string | null) =>
  fail(`${what} cannot be read (${error}). Fix it under "Advanced: edit JSON".`);

/** The search settings form (config.json). */
export async function saveConfig(_prev: SaveState, fd: FormData): Promise<SaveState> {
  const cur = readConfig();
  if (!cur.data) return unreadable('config.json', cur.error);
  return save('config', JSON.stringify(mergeConfig(cur.data, fd), null, 2));
}

/** The applicant facts form (cv/applicant.json, started from the example file when missing). */
export async function saveApplicant(_prev: SaveState, fd: FormData): Promise<SaveState> {
  const cur = readApplicant();
  if (!cur.data) return unreadable('applicant.json', cur.error);
  return save('applicant', JSON.stringify(mergeApplicant(cur.data, fd), null, 2));
}

/** "Advanced: edit JSON": the raw text, validated by the same command. */
export async function saveJson(_prev: SaveState, fd: FormData): Promise<SaveState> {
  const kind = fd.get('kind');
  if (kind !== 'config' && kind !== 'applicant') return fail('Unknown settings kind');
  const json = String(fd.get('json') ?? '');
  if (json.length > 1_000_000) return fail('Too large');
  return save(kind, json);
}

/**
 * A "Skip patterns" suggestion from /analytics, after the user confirmed it: appends the pattern to roleExclude.
 * Only a pattern the current skip history still suggests is accepted, so a forged POST cannot set anything else.
 */
export async function addRoleExclude(_prev: SaveState, fd: FormData): Promise<SaveState> {
  const cur = readConfig();
  if (!cur.data) return unreadable('config.json', cur.error);
  const roleExclude = typeof cur.data.roleExclude === 'string' ? cur.data.roleExclude : '';
  const pattern = fd.get('pattern');
  const { suggestions } = await skipInsights(roleExclude);
  if (typeof pattern !== 'string' || !suggestions.some((s) => s.pattern === pattern)) return fail('That suggestion is no longer valid.');
  return save('config', JSON.stringify({ ...cur.data, roleExclude: roleExclude ? `${roleExclude}|${pattern}` : pattern }, null, 2));
}
