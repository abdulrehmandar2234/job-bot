import { readFileSync } from 'node:fs';
import { stackErrors } from '../presets.ts';
import { APPLICANT_FILE, CONFIG_FILE, validateText, writeSettingsFile, type SettingsError, type SettingsKind } from '../settings.ts';
import type { Flags } from './shared.ts';

// For the dashboard's settings page (via runBot): both print one JSON line, {"ok":true} (with "warnings" for unknown
// config keys) or {"ok":false,"errors":[...]}, and exit non-zero on error. They need no database and work even while
// the current config.json is invalid.

const TARGET: Record<SettingsKind, string> = { config: CONFIG_FILE, applicant: APPLICANT_FILE };

/** Reads --file (or stdin) as settings of --kind and validates it. */
function check(flags: Flags): { kind: SettingsKind; obj: unknown; warnings: SettingsError[] } | { errors: SettingsError[] } {
  const kind = flags.kind;
  if (kind !== 'config' && kind !== 'applicant') return { errors: [{ path: '--kind', message: 'must be config or applicant' }] };
  let text: string;
  try {
    text = readFileSync(flags.file ?? 0, 'utf8');
  } catch (e) {
    return { errors: [{ path: '--file', message: (e as Error).message }] };
  }
  const res = validateText(kind, text);
  // Stack ids must name preset files (presets/stacks), which the schema cannot check without reading them. Reported
  // with the schema's own errors, so the dashboard's Settings page lists every problem at once.
  const stacks = kind === 'config' ? checkStacks(parsedStacks(text)) : [];
  if (!res.ok || stacks.length) return { errors: [...(res.ok ? [] : res.errors), ...stacks] };
  return { kind, obj: JSON.parse(text), warnings: res.warnings };
}

/** stackErrors, with a broken preset file reported as an error too: these commands always answer with one JSON line. */
function checkStacks(stacks: unknown): SettingsError[] {
  try {
    return stackErrors(stacks);
  } catch (e) {
    return [{ path: 'stacks', message: (e as Error).message }];
  }
}

/** The `stacks` value of config JSON text; undefined when the text is not a JSON object. */
function parsedStacks(text: string): unknown {
  try {
    const obj: unknown = JSON.parse(text);
    return obj && typeof obj === 'object' ? (obj as { stacks?: unknown }).stacks : undefined;
  } catch {
    return undefined;
  }
}

function report(r: { errors: SettingsError[] } | { warnings: SettingsError[] }) {
  if ('errors' in r) {
    console.log(JSON.stringify({ ok: false, errors: r.errors }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(r.warnings.length ? { ok: true, warnings: r.warnings } : { ok: true }));
  }
}

/** settings:check --kind config|applicant [--file x.json]: validates only. */
export function settingsCheck(_args: string[], flags: Flags) {
  report(check(flags));
}

/** settings:save --kind config|applicant [--file x.json]: validates, then replaces config.json / cv/applicant.json. */
export function settingsSave(_args: string[], flags: Flags) {
  const r = check(flags);
  if ('kind' in r) writeSettingsFile(TARGET[r.kind], r.obj);
  report(r);
}
