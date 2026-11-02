import { config } from '../config.ts';
import { upsertJob, type Job } from '../db.ts';
import { scoreJob } from '../match.ts';
import { loadProfile, remoteFromCode } from '../profile.ts';
import { parseSalary } from '../salary.ts';
import type { RawJob } from '../types.ts';

/** `--name value` flags; a flag without a value is 'true'. */
export type Flags = Record<string, string>;
/** Every CLI command: positional args and flags. See the registry in src/cli.ts. */
export type Command = (args: string[], flags: Flags) => Promise<void> | void;

export const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
/** The start of the line a command prints when it needs the AI and config.json turns it off (it then exits 0). */
export const AI_OFF = 'AI is off (config.json ai.enabled)';

export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

/** The user's own country (remote.fromCode, else the profile's countryCode): what "Rs" means in a remote job. */
export const homeCountry = () => remoteFromCode(config, loadProfile());

/** Scores a posting and upserts it as new or filtered. A source's own salary data wins over parsing the text. */
export function save({ salary: given, ...raw }: RawJob) {
  const s = scoreJob(raw);
  const salary = given ?? parseSalary(`${raw.title}\n${raw.description}`, s.country, homeCountry());
  return upsertJob({
    ...raw,
    country: s.country,
    score: s.score,
    cluster: s.cluster,
    matched: s.matched,
    missing: s.missing,
    visa: s.visa,
    visa_evidence: s.visaEvidence,
    flags: s.flags,
    status: s.filterReason ? 'filtered' : 'new',
    filter_reason: s.filterReason,
    salary_min: salary?.min ?? null,
    salary_max: salary?.max ?? null,
    salary_currency: salary?.currency ?? null,
    salary_period: salary?.period ?? null,
  });
}

export function row(j: Job) {
  return (
    `${String(j.score).padStart(3)}  ${(j.country ?? '--').padEnd(2)}  ${j.status.padEnd(9)} ${j.company} — ${j.title}  [${j.cluster}]` +
    `${j.flags.length ? `  ⚠ ${j.flags.join('; ')}` : ''}\n      id: ${j.id}`
  );
}
