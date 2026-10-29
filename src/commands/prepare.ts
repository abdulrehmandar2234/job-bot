import { mkdirSync, writeFileSync } from 'node:fs';
import { config, path } from '../config.ts';
import { getJob, pool, setStatus, type JobStatus } from '../db.ts';
import { cvFile, versionFor } from '../cv/versions.ts';
import { PROFILES } from '../cv/profiles.ts';
import { coverLetter } from '../cover.ts';
import { aiCoverLetter } from '../ai.ts';
import { isOpen } from '../sources/open.ts';
import { record } from './open.ts';
import { slug, today, type Flags } from './shared.ts';

/** Statuses that `prepare` moves to `prepared`; later stages keep their status. */
export const PREPARABLE: readonly JobStatus[] = ['new', 'filtered', 'skipped', 'expired'];

/** Picks or builds the CV version and writes a cover letter. Does not apply. */
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
  // AI reads the job description; the template is the fallback (AI off, --template, or the CLI failing).
  let letter = coverLetter(j);
  let aiLetter = false;
  if (config.ai.enabled && !flags.template) {
    try {
      letter = await aiCoverLetter(j);
      aiLetter = true;
    } catch (e) {
      console.log(`AI cover letter failed, using template: ${(e as Error).message}`);
    }
  }
  const dir = path('applications', `${today()}-${slug(j.company)}-${slug(j.title)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/cover-letter.txt`, letter);
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
  await pool.query('UPDATE jobs SET cv_version = $2, cover_letter = $3, cover_letter_ai = $4 WHERE id = $1', [j.id, id, letter, aiLetter]);
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
  console.log(`Cover      : ${dir}/cover-letter.txt ${aiLetter ? '(written by AI from the job description)' : '(template)'}`);
  console.log(`Apply at   : ${j.url}`);
  console.log(`\nAfter submitting: npm run bot -- mark ${j.id} applied`);
}
