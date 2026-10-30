import type { Job } from '@/lib/db';

type VisaInfo = Pick<Job, 'visa'> & Partial<Pick<Job, 'visa_evidence'>>;

// How sure the visa note is (job-bot/src/match.ts): only the posting itself counts as "offered".
const LABEL = {
  offered: { text: '✓ Visa/relocation offered', tone: 'text-emerald-700 dark:text-emerald-400' },
  'not-needed': { text: '✓ No visa needed', tone: 'text-emerald-700 dark:text-emerald-400' },
  'can-sponsor': { text: '? Company can sponsor, posting does not say', tone: 'text-amber-700 dark:text-amber-400' },
  silent: { text: '? Visa/relocation not mentioned', tone: 'text-amber-700 dark:text-amber-400' },
} as const;

/** The visa label: green when the posting offers it (or none is needed), amber when it says nothing. */
export function VisaBadge({ job }: { job: VisaInfo }) {
  if (!job.visa_evidence) {
    // Jobs scored before the label existed keep their old note until the next re-score.
    return job.visa ? <span className="text-zinc-500">{job.visa}</span> : null;
  }
  const { text, tone } = LABEL[job.visa_evidence];
  return (
    <span className={tone} title={job.visa ?? undefined}>
      {text}
    </span>
  );
}
