import { config } from '../config.ts';
import { getJob, pool } from '../db.ts';
import { aiInterviewPrep } from '../ai.ts';

/** prep <id>: AI interview prep (questions, STAR stories, company brief, requirement map), stored on the job. */
export async function prep(args: string[]) {
  const j = await getJob(args[0]);
  if (!j) return console.log('Not found');
  if (!config.ai.enabled) return console.log('AI is off (config.json ai.enabled), so there is no interview prep.');
  console.log(`Preparing interview notes for ${j.company} — ${j.title} with ${config.ai.letterModel}...`);
  const p = await aiInterviewPrep(j);
  await pool.query('UPDATE jobs SET interview_prep = $2, interview_prep_at = now() WHERE id = $1', [j.id, JSON.stringify(p)]);
  console.log(`${p.technical.length} technical and ${p.behavioural.length} behavioural questions, ` +
    `${p.requirements.filter((r) => r.gap).length} of ${p.requirements.length} requirements are gaps.`);
  if (p.company.verify.length) console.log(`Verify before the interview:\n- ${p.company.verify.join('\n- ')}`);
  console.log('Open the job in the dashboard to read and copy it.');
}
