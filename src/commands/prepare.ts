import { mkdirSync, writeFileSync } from 'node:fs';
import { config, path } from '../config.ts';
import { getJob, pool, setStatus } from '../db.ts';
import { cvFile, versionFor } from '../cv/versions.ts';
import { PROFILES } from '../cv/profiles.ts';
import { coverLetter } from '../cover.ts';
import { aiCoverLetter } from '../ai.ts';
import { slug, today, type Flags } from './shared.ts';

/** Picks or builds the CV version and writes a cover letter. Does not apply. */
export async function prepare(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  const forced = flags.cv; // --cv default | --cv laravel | --cv custom-xyz
  const cluster = forced ?? (config.autoCvVersions ? j.cluster ?? 'default' : 'default');
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
  writeFileSync(`${dir}/application.json`, JSON.stringify({
    jobId: j.id, company: j.company, title: j.title, applyUrl: j.url, cvVersion: id, cvFile: cvFile(id), preparedAt: new Date().toISOString(),
  }, null, 2));
  await pool.query('UPDATE jobs SET cv_version = $2, cover_letter = $3, cover_letter_ai = $4 WHERE id = $1', [j.id, id, letter, aiLetter]);
  // Preparing a filtered/skipped job is a manual override, so it moves into the pipeline too.
  if (['new', 'filtered', 'skipped'].includes(j.status)) await setStatus(j.id, 'prepared', `CV: ${id}`);
  console.log(`${j.company} — ${j.title}`);
  console.log(`CV version : ${id}${created ? ' (newly generated)' : ''}`);
  if (id === 'default' && j.cluster && j.cluster !== 'default') console.log(`             (if needed, a "${j.cluster}" version can be made: prepare ${j.id} --cv ${j.cluster})`);
  console.log(`CV file    : ${cvFile(id)}`);
  console.log(`Cover      : ${dir}/cover-letter.txt ${aiLetter ? '(written by AI from the job description)' : '(template)'}`);
  console.log(`Apply at   : ${j.url}`);
  console.log(`\nAfter submitting: npm run bot -- mark ${j.id} applied`);
}
