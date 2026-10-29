import { upsertJob, type Job } from '../db.ts';
import { scoreJob } from '../match.ts';
import type { RawJob } from '../types.ts';

/** `--name value` flags; a flag without a value is 'true'. */
export type Flags = Record<string, string>;
/** Every CLI command: positional args and flags. See the registry in src/cli.ts. */
export type Command = (args: string[], flags: Flags) => Promise<void> | void;

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

/** Scores a posting and upserts it as new or filtered. */
export function save(raw: RawJob) {
  const s = scoreJob(raw);
  return upsertJob({
    ...raw,
    country: s.country,
    score: s.score,
    cluster: s.cluster,
    matched: s.matched,
    missing: s.missing,
    visa: s.visa,
    flags: s.flags,
    status: s.filterReason ? 'filtered' : 'new',
    filter_reason: s.filterReason,
  });
}

export function row(j: Job) {
  return `${String(j.score).padStart(3)}  ${(j.country ?? '--').padEnd(2)}  ${j.status.padEnd(9)} ${j.company} — ${j.title}  [${j.cluster}]` +
    `${j.flags.length ? `  ⚠ ${j.flags.join('; ')}` : ''}\n      id: ${j.id}`;
}
