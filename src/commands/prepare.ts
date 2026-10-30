import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { config, path } from '../config.ts';
import { getJob, pool, setStatus, type Job, type JobStatus } from '../db.ts';
import { cvFile, masterRaw, versionFor } from '../cv/versions.ts';
import { htmlToPdf, letterHtml, type Cv } from '../cv/render.ts';
import { PROFILES } from '../cv/profiles.ts';
import { coverLetter } from '../cover.ts';
import { aiCoverLetter, aiSummary } from '../ai.ts';
import { FEEDBACK_CAP } from '../tasks.ts';
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
 * The --feedback flag as text: '' when absent. Sets the exit code and returns null when it is not usable (a bare
 * --feedback, or longer than FEEDBACK_CAP; the dashboard and task:run check the same).
 */
function feedbackFlag(flags: Flags): string | null {
  if (flags.feedback === undefined) return '';
  const text = flags.feedback === 'true' ? '' : flags.feedback.trim();
  if (!text || flags.feedback.length > FEEDBACK_CAP) {
    console.error(`--feedback needs text of at most ${FEEDBACK_CAP} characters, e.g. --feedback "shorter"`);
    process.exitCode = 1;
    return null;
  }
  return text;
}

/**
 * Writes the cover letter: AI from the job description, else the template (AI off, --template, or the AI failing).
 * With `feedback`, the AI rewrites the current letter instead; that needs the AI, so it never falls back to the
 * template (which would throw the current letter away) and throws instead.
 * Stores it on the job and in the job's applications/ folder. Returns where it went, whether the AI wrote it and
 * the AI's note on feedback it did not follow.
 */
export async function writeLetter(j: Job, flags: Flags = {}, feedback = '') {
  let letter = coverLetter(j);
  let ai = false;
  let note = '';
  if (feedback) {
    if (!config.ai.enabled) throw new Error('Rewriting with feedback needs the AI, and it is off (config.json ai.enabled).');
    ({ letter, note } = await aiCoverLetter(j, feedback));
    ai = true;
  } else if (config.ai.enabled && !flags.template) {
    try {
      letter = (await aiCoverLetter(j)).letter;
      ai = true;
    } catch (e) {
      console.log(`AI cover letter failed, using template: ${(e as Error).message}`);
    }
  }
  const file = `${applicationDir(j)}/cover-letter.txt`;
  writeFileSync(file, letter);
  await pool.query('UPDATE jobs SET cover_letter = $2, cover_letter_ai = $3, cover_letter_edited_at = NULL WHERE id = $1', [
    j.id,
    letter,
    ai,
  ]);
  return { file, ai, note };
}

/**
 * letter <id> [--template] [--feedback "shorter"]: writes (or rewrites) the cover letter on its own. With --feedback
 * the AI rewrites the current letter to follow it. Status and CV are left alone.
 */
export async function letter(args: string[], flags: Flags) {
  const feedback = feedbackFlag(flags);
  if (feedback === null) return;
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  let res: Awaited<ReturnType<typeof writeLetter>>;
  try {
    res = await writeLetter(j, flags, feedback);
  } catch (e) {
    console.error(`Could not ${feedback ? 'rewrite' : 'write'} the letter, it is unchanged: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${j.company} — ${j.title}`);
  const how = feedback ? '(rewritten by AI with your feedback)' : res.ai ? '(written by AI from the job description)' : '(template)';
  console.log(`Cover      : ${res.file} ${how}`);
  if (res.note) console.log(`Note       : ${res.note}`);
}

/**
 * summary <id> [--feedback "…"]: the AI writes a CV summary for this job from the CV and the job description (or
 * rewrites the current one to follow the feedback) and stores it on the job. `cv:tailor <id>` puts it in a CV.
 * There is no template: when the AI is off or fails, nothing changes and it exits 1.
 */
export async function summary(args: string[], flags: Flags) {
  const feedback = feedbackFlag(flags);
  if (feedback === null) return;
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (!config.ai.enabled) {
    console.error('The CV summary is written by the AI, and it is off (config.json ai.enabled).');
    process.exitCode = 1;
    return;
  }
  let res: Awaited<ReturnType<typeof aiSummary>>;
  try {
    res = await aiSummary(j, feedback);
  } catch (e) {
    console.error(`AI summary failed${j.cv_summary ? ', the summary is unchanged' : ''}: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  await pool.query('UPDATE jobs SET cv_summary = $2, cv_summary_at = now(), cv_summary_edited_at = NULL WHERE id = $1', [
    j.id,
    res.summary,
  ]);
  console.log(`${j.company} — ${j.title}`);
  console.log(`CV summary : ${feedback ? '(rewritten by AI with your feedback)' : '(written by AI for this job)'}`);
  console.log(res.summary);
  if (res.note) console.log(`Note       : ${res.note}`);
  console.log(`To put it in a CV for this job: npm run bot -- cv:tailor ${j.id}`);
}

/**
 * letter:pdf <id>: prints the job's cover letter to `cover-letter.pdf` in its applications/ folder, with the CV's
 * name, title and contact as the header. The dashboard's "Download PDF" runs this and serves the file.
 */
export async function letterPdf(args: string[]) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (!j.cover_letter) {
    console.log(`No cover letter yet: npm run bot -- letter ${j.id}`);
    process.exitCode = 1;
    return;
  }
  const cv = JSON.parse(masterRaw()) as Cv;
  const file = `${applicationDir(j)}/cover-letter.pdf`;
  await htmlToPdf(letterHtml(cv, j.cover_letter), file);
  console.log(`PDF        : ${file}`);
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
