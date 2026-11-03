import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { getJob, pool, setStatus, withLock, type Job } from '../db.ts';
import { aiAnswers, aiScore as review } from '../ai.ts';
import { aiLabel } from '../ai-providers.ts';
import { notify, strongAlerts, type AlertJob } from '../notify.ts';
import { AI_OFF, type Flags } from './shared.ts';

/** AI review of matching jobs via the configured AI provider (config.json ai.provider): ai:score [--id <job>] [--limit 80] [--all] */
export async function aiScore(_args: string[], flags: Flags) {
  // Not an error: `bot daily` runs this every morning, and with the AI off there is simply nothing to do.
  if (!config.ai.enabled) return console.log(`${AI_OFF}, so no jobs were AI-reviewed.`);
  // Only one bulk review at a time (like fetch): the daily run and a dashboard task would otherwise both read the
  // same unscored queue and spend AI calls on every job twice. A single job (--id) is guarded by the task queue.
  if (flags.id) return scoreQueue(flags);
  if (!(await withLock('ai:score', () => scoreQueue(flags)))) console.log('An ai:score is already running; skipping.');
}

async function scoreQueue(flags: Flags) {
  const params: (string | number)[] = [];
  let where = `status = 'new' AND duplicate_of IS NULL AND ai_scored_at IS NULL`;
  if (flags.id) {
    where = 'id = $1';
    params.push(flags.id);
  } else if (flags.all) where = `status = 'new' AND duplicate_of IS NULL`;
  // Jobs an earlier AI review filtered for their location: checked again, and back in Matching if they now pass.
  else if (flags['location-filtered']) where = `status = 'filtered' AND filter_reason LIKE 'location (AI):%' AND duplicate_of IS NULL`;
  params.push(Number(flags.limit ?? config.ai.maxScorePerRun));
  const { rows: queue } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE ${where} ORDER BY score DESC, posted_at DESC NULLS LAST LIMIT $${params.length}`,
    params,
  );
  if (!queue.length) return console.log('Nothing to score.');
  const total = queue.length;
  console.log(`AI scoring ${total} jobs with ${aiLabel('score')}...`);
  let done = 0;
  let failed = 0;
  let firstError = '';
  const strong: string[] = [];
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      try {
        const r = await review(j);
        const where = r.location?.eligible ?? null;
        const why = r.location?.reason?.trim() || null;
        const flags =
          where === 'unclear'
            ? [`Location unclear: confirm you can work from where you live${why ? ` (${why})` : ''}`, ...r.red_flags]
            : r.red_flags;
        await pool.query(
          `UPDATE jobs SET ai_score = $2, ai_verdict = $3, ai_summary = $4, ai_reasons = $5, ai_gaps = $6,
          ai_flags = $7, ai_location = $8, ai_location_reason = $9, ai_scored_at = now() WHERE id = $1`,
          [j.id, r.score, r.verdict, r.summary, r.reasons, r.gaps, flags, where, why],
        );
        const ruledOut = where === 'no' && (await excludeForLocation(j.id, why));
        const restored = where !== 'no' && where !== null && (await restoreLocationFiltered(j, why));
        console.log(
          `${String(r.score).padStart(3)} ${r.verdict.padEnd(7)} ${j.company} — ${j.title}${
            ruledOut ? `  → filtered: location (${why})` : restored ? '  → back in Matching: location check passed' : ''
          }`,
        );
        done++;
        if (r.verdict === 'strong' && where !== 'no' && (j.status === 'new' || restored)) strong.push(j.id);
      } catch (e) {
        failed++;
        firstError ||= (e as Error).message;
        console.log(`  ✗ ${j.company} — ${j.title}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: config.ai.concurrency }, worker));
  console.log(`${done} jobs scored${failed ? `, ${failed} failed` : ''}.`);
  await alertStrong(strong);
  // A failed review must not look like success: the job asked for with --id, or the whole queue, failing exits 1,
  // so a dashboard task ends as failed and the scheduled run reports the error.
  if (failed && (flags.id || failed === total)) {
    console.error(`AI review failed for ${failed} of ${total} job${total === 1 ? '' : 's'}: ${firstError.slice(0, 500)}`);
    process.exitCode = 1;
  }
}

/** The filter reason for a job the AI found closed to the candidate's location. Kept across re-scores (see upsertJob). */
export const locationReason = (why: string | null) => `location (AI): ${why || 'not open to where you live'}`.slice(0, 300);

/**
 * Moves a matching job the AI found closed to the candidate's location to `filtered`, with the reason. Only from
 * `new`: a job the user already acted on keeps its status (the reason is still shown with the AI review).
 */
async function excludeForLocation(id: string, why: string | null) {
  // Already filtered by an earlier location check: keep it there, with the newest reason.
  await pool.query(`UPDATE jobs SET filter_reason = $2 WHERE id = $1 AND status = 'filtered' AND filter_reason LIKE 'location (AI):%'`, [
    id,
    locationReason(why),
  ]);
  // Status and reason change in one transaction (setStatus `set`): a crash never leaves one without the other.
  return setStatus(id, 'filtered', locationReason(why), undefined, { expectFrom: ['new'], set: { filter_reason: locationReason(why) } });
}

/**
 * Moves a job that an earlier AI review filtered for its location back to `new` when a new review no longer rules
 * it out ("yes" or "unclear"). Only that kind of filtered job: the keyword rules' own filters stay.
 */
async function restoreLocationFiltered(j: Job, why: string | null) {
  if (j.status !== 'filtered' || !j.filter_reason?.startsWith('location (AI):')) return false;
  // Status and reason change in one transaction (setStatus `set`): a crash never leaves one without the other.
  return setStatus(j.id, 'new', `location (AI) passed: ${why ?? ''}`.trim(), undefined, {
    expectFrom: ['filtered'],
    set: { filter_reason: null },
  });
}

const countryName = (c: string | null) => (c === 'RM' ? 'Remote' : c && config.countries[c]?.name) || c || 'unknown country';

/** macOS alert for jobs the AI just rated strong (grouped above 3). alerted_at makes it once per job, even if re-scored. */
async function alertStrong(ids: string[]) {
  if (!ids.length || config.ai.alertStrong === false) return;
  const { rows } = await pool.query<AlertJob & { ai_score: number }>(
    `UPDATE jobs SET alerted_at = now() WHERE id = ANY($1) AND ai_verdict = 'strong' AND alerted_at IS NULL
     RETURNING id, title, company, country, ai_score`,
    [ids],
  );
  rows.sort((a, b) => b.ai_score - a.ai_score);
  for (const n of strongAlerts(rows, countryName)) {
    console.log(`Alert: ${n.message}`);
    await notify(n);
  }
}

/** Drafts answers to application-form questions: answer <id> [--file questions.txt] (or stdin) [--clear]. Never submits. */
export async function answer(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (flags.clear) {
    await pool.query(`UPDATE jobs SET form_answers = '[]' WHERE id = $1`, [j.id]);
    return console.log('Answers cleared.');
  }
  if (!config.ai.enabled) return console.log(`${AI_OFF}, so no answers were drafted.`);
  const questions = (flags.file ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8')).trim();
  if (!questions) return console.log('No questions given.');
  const fresh = await aiAnswers(j, questions);
  // Re-asked questions replace their old answer; the rest are kept.
  const key = (q: string) =>
    q
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const old = j.form_answers.filter((a) => !fresh.some((f) => key(f.question) === key(a.question)));
  await pool.query('UPDATE jobs SET form_answers = $2 WHERE id = $1', [j.id, JSON.stringify([...old, ...fresh])]);
  for (const a of fresh) console.log(`\nQ: ${a.question}\nA: ${a.answer}${a.note ? `\n   (${a.note})` : ''}`);
  const todo = fresh.filter((a) => a.needs_input).length;
  if (todo) console.log(`\n${todo} answer(s) need your input ([FILL: ...]). Add the facts to cv/applicant.json to fill them next time.`);
}
