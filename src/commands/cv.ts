import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { getJob, pool, type Job } from '../db.ts';
import {
  cvFile,
  customCv,
  customVersion,
  jobTemplate,
  listVersions,
  masterRaw,
  versionCv,
  versionFor,
  versionMeta,
  versionTemplate,
} from '../cv/versions.ts';
import { renderPdf, type Cv } from '../cv/render.ts';
import { PROFILES } from '../cv/profiles.ts';
import { keepToMaster } from '../cv/feedback.ts';
import { isTemplate, TEMPLATE_IDS } from '../cv/templates/index.ts';
import { aiCvFeedback, aiCvReview } from '../ai.ts';
import { feedbackFlag } from './prepare.ts';
import { AI_OFF, slug, type Flags } from './shared.ts';

/** The slug of a job's one-off CV folders: custom-<slug>-v<N>. */
const jobSlug = (j: Pick<Job, 'company' | 'title'>) => slug(`${j.company}-${j.title}`).slice(0, 40);

/** Re-renders the default CV from cv/master.json. The original PDF stays in cv/original/. */
export async function cvDefault() {
  await renderPdf(JSON.parse(masterRaw()) as Cv, cvFile('default'));
  console.log(`default CV rebuilt from master.json → ${cvFile('default')}`);
}

/** cv:build [cluster...]: pre-builds CV versions (all profiles by default). */
export async function cvBuild(args: string[]) {
  for (const cluster of args.length ? args : Object.keys(PROFILES)) {
    const v = await versionFor(cluster);
    console.log(`${v.created ? 'built ' : 'exists'} ${v.id}  → ${cvFile(v.id)}`);
  }
}

export async function versions() {
  const { rows } = await pool.query<{ cv_version: string; n: number }>(
    'SELECT cv_version, count(*)::int n FROM jobs WHERE cv_version IS NOT NULL GROUP BY 1',
  );
  const used = (id: string) => rows.find((r) => r.cv_version === id)?.n ?? 0;
  console.log(`default            → ${cvFile('default')}  (used for ${used('default')} jobs)`);
  for (const v of listVersions()) console.log(`${v.id.padEnd(18)} → ${cvFile(v.id)}  (${versionTemplate(v)}, used for ${used(v.id)} jobs)`);
}

/** One-off CV for a single job: --overrides file.json with {title, summary, skillsFirst, groupsFirst, projectTags, bulletKeywords} */
export async function custom(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  const overrides = JSON.parse(readFileSync(flags.overrides, 'utf8'));
  const meta = await customVersion(jobSlug(j), j.cluster ?? 'default', j.id, overrides, jobTemplate(j));
  await pool.query('UPDATE jobs SET cv_version = $2 WHERE id = $1', [j.id, meta.id]);
  console.log(`Custom CV: ${cvFile(meta.id)}`);
}

/**
 * The cluster whose profile a tailored CV starts from: the one of the job's current CV version, so the tailored CV
 * differs from it only in the summary. Without a version, the one `prepare` would pick.
 */
function baseCluster(j: { cv_version: string | null; cluster: string | null }): string {
  if (j.cv_version === 'default') return 'default';
  const current = j.cv_version && listVersions().find((v) => v.id === j.cv_version);
  if (current) return current.cluster;
  return config.autoCvVersions ? (j.cluster ?? 'default') : 'default';
}

/**
 * cv:tailor <id>: a one-off CV version for the job whose summary is the job's CV summary (`bot summary <id>`), in a
 * new folder every time. Sets it as the job's CV, which "Download CV" on the job page serves.
 */
export async function cvTailor(args: string[]) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (!j.cv_summary) {
    console.error(`No CV summary for this job yet: npm run bot -- summary ${j.id}`);
    process.exitCode = 1;
    return;
  }
  const meta = await customVersion(jobSlug(j), baseCluster(j), j.id, { summary: j.cv_summary }, jobTemplate(j));
  await pool.query('UPDATE jobs SET cv_version = $2 WHERE id = $1', [j.id, meta.id]);
  console.log(`${j.company} — ${j.title}`);
  console.log(`CV version : ${meta.id} (with the CV summary for this job)`);
  console.log(`Template   : ${jobTemplate(j)}`);
  console.log(`CV file    : ${cvFile(meta.id)}`);
}

/**
 * cv:template <id> <template>: sets the job's CV template and re-renders its CV in it as a new version, which becomes
 * the job's CV. The CV it had stays on disk untouched (it may have been sent). A one-off CV keeps its content in a new
 * custom-<slug>-v<N> folder; a shared version (default or a cluster) switches to that version in the new template.
 * Without a CV yet, only the template is set, and `prepare` uses it.
 */
export async function cvTemplate(args: string[]) {
  const [id, template] = args;
  if (!isTemplate(template)) {
    console.error(`Usage: cv:template <id> <template>, where <template> is one of: ${TEMPLATE_IDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const j = await getJob(id);
  if (!j) return console.log('Not found');
  console.log(`${j.company} — ${j.title}`);
  if (!j.cv_version) {
    await pool.query('UPDATE jobs SET cv_template = $2 WHERE id = $1', [j.id, template]);
    console.log(`Template   : ${template} (no CV yet: "Prepare CV" builds it in this template)`);
    return;
  }
  const meta = versionMeta(j.cv_version);
  if (versionTemplate(meta) === template && (meta || j.cv_version === 'default')) {
    await pool.query('UPDATE jobs SET cv_template = $2 WHERE id = $1', [j.id, template]);
    console.log(`Template   : ${template} (the CV ${j.cv_version} already uses it)`);
    return;
  }
  let made: { id: string; created: boolean };
  if (meta?.jobId) made = { id: (await customCv(jobSlug(j), meta.cluster, j.id, versionCv(j.cv_version), template)).id, created: true };
  else made = await versionFor(meta?.cluster ?? baseCluster(j), template);
  await pool.query('UPDATE jobs SET cv_template = $2, cv_version = $3 WHERE id = $1', [j.id, template, made.id]);
  console.log(`Template   : ${template}`);
  console.log(`CV version : ${made.id}${made.created ? ' (newly generated)' : ''} (was ${j.cv_version}, kept as it is)`);
  console.log(`CV file    : ${cvFile(made.id)}`);
}

/**
 * cv:feedback <id> --feedback "…": the AI revises the job's CV (its current version, else the master CV) to follow
 * the feedback. keepToMaster() then drops anything the master CV does not have. The result is a new one-off version
 * in the job's template that becomes the job's CV; the note says what the AI and the check left out.
 */
export async function cvFeedback(args: string[], flags: Flags) {
  const feedback = feedbackFlag(flags);
  if (feedback === null) return;
  if (!feedback) {
    console.error('cv:feedback needs --feedback "what should change", e.g. --feedback "put Laravel experience first"');
    process.exitCode = 1;
    return;
  }
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (!config.ai.enabled) return console.log(`${AI_OFF}: improving the CV with feedback needs it, so the CV is unchanged.`);
  const master = JSON.parse(masterRaw()) as Cv;
  const current = versionCv(j.cv_version);
  let res: Awaited<ReturnType<typeof aiCvFeedback>>;
  try {
    res = await aiCvFeedback(j, master, current, feedback);
  } catch (e) {
    console.error(`AI CV revision failed, the CV is unchanged: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const { cv, removed } = keepToMaster(res.cv ?? {}, master, current);
  const note = (res.note ?? '').trim();
  const template = jobTemplate(j);
  const cluster = (j.cv_version && versionMeta(j.cv_version)?.cluster) || 'default';
  // The note is kept in meta.json too, so the job page can show what was left out of this version.
  const meta = await customCv(jobSlug(j), cluster, j.id, cv, template, [...(note ? [note] : []), ...removed]);
  await pool.query('UPDATE jobs SET cv_version = $2 WHERE id = $1', [j.id, meta.id]);
  console.log(`${j.company} — ${j.title}`);
  console.log(`CV version : ${meta.id} (revised by AI with your feedback${j.cv_version ? `; ${j.cv_version} stays as it is` : ''})`);
  console.log(`Template   : ${template}`);
  console.log(`CV file    : ${cvFile(meta.id)}`);
  if (note) console.log(`Note       : ${note}`);
  for (const r of removed) console.log(`Left out   : ${r}`);
}

/**
 * cv:review <id>: the AI reviews the job's CV against the job (what is weak or missing, what to emphasise) and stores
 * the suggestions on the job, so the user can turn them into feedback for cv:feedback. Nothing else changes.
 */
export async function cvReview(args: string[]) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (!config.ai.enabled) return console.log(`${AI_OFF}: the CV review is written by the AI, so there is none.`);
  let review: string;
  try {
    review = await aiCvReview(j, JSON.parse(masterRaw()) as Cv, versionCv(j.cv_version));
  } catch (e) {
    console.error(`AI CV review failed: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  await pool.query('UPDATE jobs SET cv_review = $2, cv_review_at = now() WHERE id = $1', [j.id, review]);
  console.log(`${j.company} — ${j.title}`);
  console.log(`CV review  : (${j.cv_version ?? 'master CV'})`);
  console.log(review);
  console.log(`To act on it: npm run bot -- cv:feedback ${j.id} --feedback "…"`);
}
