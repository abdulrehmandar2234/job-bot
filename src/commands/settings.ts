import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { APPLICANT_FILE, CONFIG_FILE, validateText, type SettingsError, type SettingsKind } from '../settings.ts';
import type { Flags } from './shared.ts';

// For the dashboard's settings page (via runBot): both print one JSON line, {"ok":true} or {"ok":false,"errors":[...]},
// and exit non-zero on error. They need no database and work even while the current config.json is invalid.

const TARGET: Record<SettingsKind, string> = { config: CONFIG_FILE, applicant: APPLICANT_FILE };

/** Reads --file (or stdin) as settings of --kind and validates it. */
function check(flags: Flags): { kind: SettingsKind; obj: unknown } | { errors: SettingsError[] } {
  const kind = flags.kind;
  if (kind !== 'config' && kind !== 'applicant') return { errors: [{ path: '--kind', message: 'must be config or applicant' }] };
  let text: string;
  try {
    text = readFileSync(flags.file ?? 0, 'utf8');
  } catch (e) {
    return { errors: [{ path: '--file', message: (e as Error).message }] };
  }
  const res = validateText(kind, text);
  return res.ok ? { kind, obj: JSON.parse(text) } : { errors: res.errors };
}

function report(r: { errors: SettingsError[] } | object) {
  if ('errors' in r) {
    console.log(JSON.stringify({ ok: false, errors: r.errors }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ok: true }));
  }
}

/** settings:check --kind config|applicant [--file x.json]: validates only. */
export function settingsCheck(_args: string[], flags: Flags) {
  report(check(flags));
}

/** settings:save --kind config|applicant [--file x.json]: validates, then replaces config.json / cv/applicant.json. */
export function settingsSave(_args: string[], flags: Flags) {
  const r = check(flags);
  if ('kind' in r) {
    // Write a temp file next to the target and rename it over, so a crash never leaves a half-written file.
    const target = TARGET[r.kind];
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(r.obj, null, 2) + '\n');
    renameSync(tmp, target);
  }
  report(r);
}
