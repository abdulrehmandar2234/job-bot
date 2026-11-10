import { aiFollowUp } from '../ai.ts';
import { config } from '../config.ts';
import { dueFollowUps, getJob, markFollowedUp, pool } from '../db.ts';
import { addressee, daysWaiting, FOLLOW_UP_DAYS, MAX_FOLLOW_UPS, templateFollowUp } from '../followup.ts';
import { loadProfile } from '../profile.ts';
import type { Contact } from '../types.ts';
import { notFound, type Flags } from './shared.ts';

/** follow-ups: applied jobs with no news for FOLLOW_UP_DAYS days that are due a follow-up. */
export async function followUps() {
  const jobs = await dueFollowUps();
  if (!jobs.length) return console.log(`No follow-ups due (applied ${FOLLOW_UP_DAYS}+ days ago with no news).`);
  console.log(`${jobs.length} applications due a follow-up:`);
  for (const j of jobs) {
    console.log(
      `  ${String(daysWaiting(j)).padStart(3)}d  ${j.company} — ${j.title}${j.follow_ups ? `  (${j.follow_ups} sent)` : ''}\n      id: ${j.id}`,
    );
  }
  console.log('Draft one: npm run bot -- follow-up <id>. After you send it: npm run bot -- followed-up <id>');
}

/** follow-up <id> [--template]: drafts a follow-up message and stores it on the job. Nothing is sent. */
export async function followUp(args: string[], flags: Flags = {}) {
  const j = await getJob(args[0]);
  if (!j) return notFound();
  if (j.status !== 'applied' && j.status !== 'interview') return console.log(`${j.id} is ${j.status}; follow-ups are for applied jobs.`);
  const { rows } = await pool.query<Contact>('SELECT * FROM contacts WHERE job_id = $1 ORDER BY created_at, id', [j.id]);
  const name = addressee(rows);
  let text = templateFollowUp(j, name, loadProfile().fullName);
  if (config.ai.enabled && !flags.template) {
    try {
      text = await aiFollowUp(j, name);
    } catch (e) {
      console.log(`AI follow-up failed, using template: ${(e as Error).message}`);
    }
  }
  await pool.query('UPDATE jobs SET follow_up_draft = $2, follow_up_draft_at = now() WHERE id = $1', [j.id, text]);
  console.log(text);
  console.log(`Send it yourself, then record it: npm run bot -- followed-up ${j.id}`);
}

/** followed-up <id>: records that the user sent a follow-up, so the reminder waits FOLLOW_UP_DAYS again. */
export async function followedUp(args: string[]) {
  const n = args[0] ? await markFollowedUp(args[0]) : null;
  if (n === null) return console.log('Usage: followed-up <id>');
  console.log(
    `${args[0]}: follow-up ${n} recorded.` +
      (n >= MAX_FOLLOW_UPS ? ' No more reminders for this job.' : ` Next reminder in ${FOLLOW_UP_DAYS} days if there is no news.`),
  );
}
