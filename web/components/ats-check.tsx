import { Suspense } from 'react';
import { type AtsReport, cachedAtsReport } from '@/lib/ats-cache';
import { addSkillsToCv } from '@/app/actions';
import { Collapsible } from './collapsible';
import { MissingSkills } from './missing-skills';
import { Chips } from './ui';

// The report shape lives with the cache; re-exported so the component's users keep one import.
export type { AtsReport } from '@/lib/ats-cache';

/**
 * "CV keyword check" for the job's prepared (or suggested) CV version. Loads on its own, so the page never waits for it.
 * `cvVersion` is the job's prepared version (or suggested cluster): part of the cache key, so a new version re-runs the check.
 * `confirm`: the missing skills can be ticked and added to the CV (the AI is on and no task is changing the CV).
 */
export function AtsCheck({ jobId, cvVersion = null, confirm = false }: { jobId: string; cvVersion?: string | null; confirm?: boolean }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Checking CV keywords…</p>}>
      <AtsLoader jobId={jobId} cvVersion={cvVersion} confirm={confirm} />
    </Suspense>
  );
}

async function AtsLoader({ jobId, cvVersion, confirm }: { jobId: string; cvVersion: string | null; confirm: boolean }) {
  let report: AtsReport;
  try {
    report = await cachedAtsReport(jobId, cvVersion);
  } catch {
    // The bot failed, or printed "Not found" instead of JSON.
    return <p className="text-sm text-zinc-500">CV keyword check is not available right now.</p>;
  }
  return <AtsLists report={report} confirmFor={confirm ? jobId : undefined} />;
}

/**
 * The check folded behind its heading, which keeps the counts visible ("shows 2 of 5 job keywords · 1 not on your
 * CV"), so a job with skills to tick is seen without opening it. With `confirmFor` (the job id), the missing skills
 * come with "I have this" checkboxes instead of plain chips.
 */
export function AtsLists({ report: r, confirmFor }: { report: AtsReport; confirmFor?: string }) {
  if (!r.total) return null;
  return (
    <Collapsible
      id="ats"
      title={
        <>
          CV keyword check{' '}
          <span className="text-xs font-normal text-zinc-500">
            · {r.label} ({r.source}) shows {r.present.length} of {r.total} job keywords
          </span>
          {r.missing.length > 0 && (
            <span className="text-xs font-normal text-rose-700 dark:text-rose-400"> · {r.missing.length} not on your CV</span>
          )}
        </>
      }
    >
      {r.present.length > 0 && (
        <div>
          <span className="text-zinc-500">Shown:</span> <Chips items={r.present} tone="good" />
        </div>
      )}
      {r.hiddenButTrue.length > 0 && (
        <div>
          <span className="text-zinc-500">On your CV but not near the top of this version:</span>{' '}
          <Chips items={r.hiddenButTrue} tone="warn" />
        </div>
      )}
      {(r.jobSkills?.length ?? 0) > 0 && (
        <div>
          <span className="text-zinc-500">Added to this job's CV only (you confirmed them here):</span>{' '}
          <Chips items={r.jobSkills!} tone="good" />
        </div>
      )}
      {r.missing.length > 0 &&
        (confirmFor ? (
          <MissingSkills id={confirmFor} missing={r.missing} add={addSkillsToCv} />
        ) : (
          <div>
            <span className="text-zinc-500">Not on your CV (add one only if you really have it):</span>{' '}
            <Chips items={r.missing} tone="bad" />
          </div>
        ))}
      {r.suggestion && (
        <p>
          💡 The <b>{r.suggestion.version}</b> version shows {r.suggestion.shows} of them
          {r.suggestion.gains.length > 0 && <> (adds {r.suggestion.gains.join(', ')})</>}.
        </p>
      )}
    </Collapsible>
  );
}
