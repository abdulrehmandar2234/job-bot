import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { UserError } from '../errors.ts';
import { upsertJob, type Job } from '../db.ts';
import { scoreJob } from '../match.ts';
import { indSalaryFlag } from '../ind-salary.ts';
import { dropInvisible } from '../posting-guard.ts';
import { loadProfile, needsVisa, remoteFromCode } from '../profile.ts';
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

/**
 * A job id (or other named thing) that does not exist: "Not found" on stderr and exit code 1, so scripts and the
 * dashboard see a failure instead of a successful run with nothing done.
 */
export function notFound(what?: string) {
  console.error(what ? `Not found: ${what}` : 'Not found');
  process.exitCode = 1;
}

/** A command used the wrong way: its usage line on stderr and exit code 1, like `notFound`. */
export function usage(text: string) {
  console.error(`Usage: ${text}`);
  process.exitCode = 1;
}

/** The text of `file`, or of stdin without one; a file that cannot be read is a UserError, not a stack trace. */
export function readInput(file?: string): string {
  try {
    return readFileSync(file ?? 0, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    throw new UserError(`Cannot read ${file ?? 'stdin'}: ${err.code === 'ENOENT' ? 'no such file' : (err.code ?? err.message)}`);
  }
}

/** `readInput` parsed as JSON; invalid JSON is a UserError naming the file. */
export function readJsonInput(file?: string): any {
  const text = readInput(file);
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UserError(`${file ?? 'stdin'} is not valid JSON: ${(e as Error).message}`);
  }
}

export const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

/** The user's own country (remote.fromCode, else the profile's countryCode): what "Rs" means in a remote job. */
export const homeCountry = () => remoteFromCode(config, loadProfile());

/** Whether a job in `country` needs a visa that the IND salary criterion applies to (a country checked against the IND register). */
export const indCheckApplies = (country: string | null) =>
  !!country && config.countries[country]?.visa === 'ind-register' && needsVisa(config, country, loadProfile());

/**
 * Scores a posting and upserts it as new or filtered. A source's own salary data wins over parsing the text.
 * Invisible characters are dropped from the text first, also for sources that send plain text.
 */
export function save({ salary: given, ...posting }: RawJob) {
  const raw = {
    ...posting,
    title: dropInvisible(posting.title),
    company: dropInvisible(posting.company),
    location: dropInvisible(posting.location ?? ''),
    description: dropInvisible(posting.description ?? ''),
  };
  const s = scoreJob(raw, config);
  const salary = given ?? parseSalary(`${raw.title}\n${raw.description}`, s.country, homeCountry());
  // A Dutch job that needs a sponsored visa: its salary must meet the IND criterion for the candidate's age.
  const ind = indCheckApplies(s.country) ? indSalaryFlag(salary, loadProfile()) : null;
  if (ind) s.flags.push(ind);
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
    deadline: s.deadline,
  });
}

export function row(j: Job) {
  return (
    `${String(j.score).padStart(3)}  ${(j.country ?? '--').padEnd(2)}  ${j.status.padEnd(9)} ${j.company} — ${j.title}  [${j.cluster}]` +
    `${j.flags.length ? `  ⚠ ${j.flags.join('; ')}` : ''}\n      id: ${j.id}`
  );
}
