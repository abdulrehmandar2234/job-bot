import { Suspense } from 'react';
import { runBot } from '@/lib/bot';
import { Chips } from './ui';

/** What `bot ats <id> --json` returns (src/ats.ts AtsReport plus the version checked). */
export type AtsReport = {
  label: string;            // version checked, e.g. laravel-v2 or next-nest
  source: string;           // prepared | suggested | chosen with --cv
  present: string[];
  hiddenButTrue: string[];
  missing: string[];
  total: number;
  suggestion: { version: string; shows: number; gains: string[] } | null;
};

/** "CV keyword check" for the job's prepared (or suggested) CV version. Loads on its own, so the page never waits for it. */
export function AtsCheck({ jobId }: { jobId: string }) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Checking CV keywords…</p>}>
      <AtsLoader jobId={jobId} />
    </Suspense>
  );
}

async function AtsLoader({ jobId }: { jobId: string }) {
  let report: AtsReport;
  try {
    report = JSON.parse(await runBot(['ats', jobId, '--json'])) as AtsReport;
  } catch {
    // The bot failed, or printed "Not found" instead of JSON.
    return <p className="text-sm text-zinc-500">CV keyword check is not available right now.</p>;
  }
  return <AtsLists report={report} />;
}

export function AtsLists({ report: r }: { report: AtsReport }) {
  if (!r.total) return null;
  return (
    <section className="space-y-2 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <h2 className="font-medium">
        CV keyword check <span className="text-xs font-normal text-zinc-500">
          · {r.label} ({r.source}) shows {r.present.length} of {r.total} job keywords</span>
      </h2>
      {r.present.length > 0 && <div><span className="text-zinc-500">Shown:</span> <Chips items={r.present} tone="good" /></div>}
      {r.hiddenButTrue.length > 0 && (
        <div>
          <span className="text-zinc-500">On your CV but not near the top of this version:</span>{' '}
          <Chips items={r.hiddenButTrue} tone="warn" />
        </div>
      )}
      {r.missing.length > 0 && (
        <div>
          <span className="text-zinc-500">Not on your CV (real gaps, do not add them):</span> <Chips items={r.missing} tone="bad" />
        </div>
      )}
      {r.suggestion && (
        <p>
          💡 The <b>{r.suggestion.version}</b> version shows {r.suggestion.shows} of them
          {r.suggestion.gains.length > 0 && <> (adds {r.suggestion.gains.join(', ')})</>}.
        </p>
      )}
    </section>
  );
}
