import { getJob, JOB_STATUSES, setStatus, SKIP_REASONS, type JobStatus, type SkipReason } from '../db.ts';
import { notFound, usage, type Flags } from './shared.ts';

/** mark <id> <status> [note] [--reason r]: records a status change the user made (applied, interview, ...). */
export async function mark(args: string[], flags: Flags = {}) {
  const [id, status, ...note] = args;
  const allowed: JobStatus[] = JOB_STATUSES.filter((s) => s !== 'filtered');
  const reason = flags.reason as SkipReason | undefined;
  if (!allowed.includes(status as JobStatus) || (reason && !SKIP_REASONS.includes(reason))) {
    return usage(`mark <id> <${allowed.join('|')}> [note] [--reason ${SKIP_REASONS.join('|')}]`);
  }
  if (!(await getJob(id))) return notFound(id);
  await setStatus(id, status as JobStatus, note.join(' ') || undefined, reason);
  console.log(`${id} → ${status}`);
  if (status === 'interview') console.log(`Prepare for it: npm run bot -- prep ${id}`);
}
