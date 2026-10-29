import { getJob, JOB_STATUSES, setStatus, type JobStatus } from '../db.ts';

/** mark <id> <status> [note]: records a status change the user made (applied, interview, ...). */
export async function mark(args: string[]) {
  const [id, status, ...note] = args;
  const allowed: JobStatus[] = JOB_STATUSES.filter((s) => s !== 'filtered');
  if (!(await getJob(id)) || !allowed.includes(status as JobStatus)) return console.log(`Usage: mark <id> <${allowed.join('|')}> [note]`);
  await setStatus(id, status as JobStatus, note.join(' ') || undefined);
  console.log(`${id} → ${status}`);
  if (status === 'interview') console.log(`Prepare for it: npm run bot -- prep ${id}`);
}
