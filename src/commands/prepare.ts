import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { config, path } from '../config.ts';
import { getJob, pool, setStatus, type Job, type JobStatus } from '../db.ts';
import { cvFile, versionFor } from '../cv/versions.ts';
import { PROFILES } from '../cv/profiles.ts';
import { coverLetter } from '../cover.ts';
import { aiCoverLetter } from '../ai.ts';
import { isOpen } from '../sources/open.ts';
import { record } from './open.ts';
import { slug, today, type Flags } from './shared.ts';

/** Statuses that `prepare` moves to `prepared`; later stages keep their status. */
export const PREPARABLE: readonly JobStatus[] = ['new', 'filtered', 'skipped', 'expired'];

/**
 * The job's folder under applications/: the newest existing `<date>-<company>-<title>` one, else a new one dated
 * today, so a letter written days after preparing lands next to the CV notes.
 */
export function applicationDir(j: Pick<Job, 'company' | 'title'>): string {
  const name = `${slug(j.company)}-${slug(j.title)}`;
  const root = path('applications');
  const existing = existsSync(root)
    ? readdirSync(root)
        .filter((d) => d.slice(11) === name && /^\d{4}-\d{2}-\d{2}-/.test(d))
        .sort()
    : [];
  const dir = existing.length ? path('applications', existing.at(-1)!) : path('applications', `${today()}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Writes the cover letter: AI from the job description, else the template (AI off, --template, or the AI failing).
 * Stores it on the job and in the job's applications/ folder. Returns where it went and whether the AI wrote it.
 */
export async function writeLetter(j: Job, flags: Flags = {}) {
  let letter = coverLetter(j);
  let ai = false;
  if (config.ai.enabled && !flags.template) {
    try {
      letter = await aiCoverLetter(j);
      ai = true;
    } catch (e) {
      console.log(`AI cover letter failed, using template: ${(e as Error).message}`);
    }
  }
  const file = `${applicationDir(j)}/cover-letter.txt`;
  writeFileSync(file, letter);
  await pool.query('UPDATE jobs SET cover_letter = $2, cover_letter_ai = $3 WHERE id = $1', [j.id, letter, ai]);
  return { file, ai };
}

/** letter <id> [--template]: writes (or rewrites) the cover letter on its own. Status and CV are left alone. */
export async function letter(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  const { file, ai } = await writeLetter(j, flags);
  console.log(`${j.company} — ${j.title}`);
  console.log(`Cover      : ${file} ${ai ? '(written by AI from the job description)' : '(template)'}`);
}

/**
 * Picks or builds the CV version. The cover letter is written only on request: `--letter` here, or `bot letter <id>`
 * ("Write letter" on the job page). Does not apply.
 */
export async function prepare(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  // A closed posting is not worth a CV and letter. --force skips the check (e.g. the site blocks the bot).
  if (!flags.force) {
    const r = await isOpen(j);
    const outcome = await record(j, r);
    if (r.state === 'closed') {
      console.log(`${j.company} — ${j.title}: the posting is closed (${r.reason}).`);
      console.log(outcome === 'expired' ? `Marked expired. Nothing prepared.` : `Status ${j.status} kept. Nothing prepared.`);
      console.log(`To prepare it anyway: npm run bot -- prepare ${j.id} --force`);
      return;
    }
    if (r.state === 'unknown') console.log(`Could not check whether the posting is still open (${r.reason}); preparing anyway.`);
  }
  const forced = flags.cv; // --cv default | --cv laravel | --cv custom-xyz
  const cluster = forced ?? (config.autoCvVersions ? (j.cluster ?? 'default') : 'default');
  const { id, created } = forced && !PROFILES[forced] ? { id: forced, created: false } : await versionFor(cluster);
  const dir = applicationDir(j);
  writeFileSync(
    `${dir}/application.json`,
    JSON.stringify(
      {
        jobId: j.id,
        company: j.company,
        title: j.title,
        applyUrl: j.url,
        cvVersion: id,
        cvFile: cvFile(id),
        preparedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await pool.query('UPDATE jobs SET cv_version = $2 WHERE id = $1', [j.id, id]);
  const written = flags.letter ? await writeLetter(j, flags) : null;
  // Preparing a filtered/skipped/expired job is a manual override, so it moves into the pipeline too.
  // j.status was read before the open check and the AI call (minutes); a status set meanwhile (e.g. applied) wins.
  if (PREPARABLE.includes(j.status)) {
    const moved = await setStatus(j.id, 'prepared', `CV: ${id}`, undefined, { expectFrom: PREPARABLE });
    if (!moved) console.log(`Status changed meanwhile, left as ${(await getJob(j.id))?.status ?? j.status}.`);
  }
  console.log(`${j.company} — ${j.title}`);
  console.log(`CV version : ${id}${created ? ' (newly generated)' : ''}`);
  if (id === 'default' && j.cluster && j.cluster !== 'default')
    console.log(`             (if needed, a "${j.cluster}" version can be made: prepare ${j.id} --cv ${j.cluster})`);
  console.log(`CV file    : ${cvFile(id)}`);
  console.log(
    written
      ? `Cover      : ${written.file} ${written.ai ? '(written by AI from the job description)' : '(template)'}`
      : `Cover      : not written yet (npm run bot -- letter ${j.id}, or "Write letter" on the job page)`,
  );
  console.log(`Apply at   : ${j.url}`);
  console.log(`\nAfter submitting: npm run bot -- mark ${j.id} applied`);
}
