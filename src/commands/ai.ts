import { readFileSync } from 'node:fs';
import { config } from '../config.ts';
import { getJob, pool, type Job } from '../db.ts';
import { aiAnswers, aiScore as review } from '../ai.ts';
import type { Flags } from './shared.ts';

/** AI review of matching jobs via the local Claude CLI: ai:score [--id <job>] [--limit 80] [--all] */
export async function aiScore(_args: string[], flags: Flags) {
  const params: (string | number)[] = [];
  let where = `status = 'new' AND duplicate_of IS NULL AND ai_scored_at IS NULL`;
  if (flags.id) { where = 'id = $1'; params.push(flags.id); }
  else if (flags.all) where = `status = 'new' AND duplicate_of IS NULL`;
  params.push(Number(flags.limit ?? config.ai.maxScorePerRun));
  const { rows: queue } = await pool.query<Job>(
    `SELECT * FROM jobs WHERE ${where} ORDER BY score DESC, posted_at DESC NULLS LAST LIMIT $${params.length}`, params);
  if (!queue.length) return console.log('Nothing to score.');
  console.log(`AI scoring ${queue.length} jobs with ${config.ai.scoreModel}...`);
  let done = 0;
  const worker = async () => {
    for (let j = queue.shift(); j; j = queue.shift()) {
      try {
        const r = await review(j);
        await pool.query(`UPDATE jobs SET ai_score = $2, ai_verdict = $3, ai_summary = $4, ai_reasons = $5, ai_gaps = $6,
          ai_flags = $7, ai_scored_at = now() WHERE id = $1`, [j.id, r.score, r.verdict, r.summary, r.reasons, r.gaps, r.red_flags]);
        console.log(`${String(r.score).padStart(3)} ${r.verdict.padEnd(7)} ${j.company} — ${j.title}`);
        done++;
      } catch (e) {
        console.log(`  ✗ ${j.company} — ${j.title}: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: config.ai.concurrency }, worker));
  console.log(`${done} jobs scored.`);
}

/** Drafts answers to application-form questions: answer <id> [--file questions.txt] (or stdin) [--clear]. Never submits. */
export async function answer(args: string[], flags: Flags) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (flags.clear) {
    await pool.query(`UPDATE jobs SET form_answers = '[]' WHERE id = $1`, [j.id]);
    return console.log('Answers cleared.');
  }
  const questions = (flags.file ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8')).trim();
  if (!questions) return console.log('No questions given.');
  const fresh = await aiAnswers(j, questions);
  // Re-asked questions replace their old answer; the rest are kept.
  const key = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const old = j.form_answers.filter((a) => !fresh.some((f) => key(f.question) === key(a.question)));
  await pool.query('UPDATE jobs SET form_answers = $2 WHERE id = $1', [j.id, JSON.stringify([...old, ...fresh])]);
  for (const a of fresh) console.log(`\nQ: ${a.question}\nA: ${a.answer}${a.note ? `\n   (${a.note})` : ''}`);
  const todo = fresh.filter((a) => a.needs_input).length;
  if (todo) console.log(`\n${todo} answer(s) need your input ([FILL: ...]). Add the facts to cv/applicant.json to fill them next time.`);
}
