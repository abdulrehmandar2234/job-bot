import { MIN_SKIPS, type SkipInsights } from '@/lib/skip-insights';
import { SKIP_LABEL } from '@/lib/skips';
import { SkipSuggestion } from './skip-suggestion';

/** Why you skip jobs, title words only skipped jobs have, and roleExclude suggestions from them. */
export function SkipPatterns({ insights }: { insights: SkipInsights }) {
  const { counts, words, suggestions } = insights;
  if (!counts.length)
    return <p className="text-sm text-zinc-500">No skipped jobs yet. Pick a reason next to Skip and patterns show up here.</p>;
  const max = Math.max(...counts.map((c) => c.n));
  return (
    <div className="space-y-4 text-sm">
      <ul className="space-y-1">
        {counts.map((c) => (
          <li key={c.reason ?? 'none'} className="grid grid-cols-[8rem_1fr_2.5rem] items-center gap-3">
            <span className={c.reason ? '' : 'text-zinc-500'}>{c.reason ? SKIP_LABEL[c.reason] : 'No reason'}</span>
            <div aria-hidden className="h-2.5 rounded-full bg-zinc-100 dark:bg-zinc-800">
              <div className="h-full rounded-full bg-rose-400" style={{ width: `${Math.round((c.n / max) * 100)}%` }} />
            </div>
            <span className="text-right tabular-nums">{c.n}</span>
          </li>
        ))}
      </ul>
      <div className="space-y-1">
        <h3 className="font-medium">Title words only in jobs skipped for stack or seniority</h3>
        {words.length ? (
          <p className="flex flex-wrap gap-1">
            {words.map((w) => (
              <span key={w.word} className="rounded bg-rose-50 px-1.5 py-0.5 text-xs text-rose-800 dark:bg-rose-950 dark:text-rose-300">
                {w.word} <span className="tabular-nums opacity-70">{w.skips}</span>
              </span>
            ))}
          </p>
        ) : (
          <p className="text-zinc-500">None yet.</p>
        )}
      </div>
      <div className="space-y-1">
        <h3 className="font-medium">Suggestions</h3>
        {suggestions.length ? (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {suggestions.map((s) => (
              <SkipSuggestion key={s.pattern} s={s} />
            ))}
          </ul>
        ) : (
          <p className="text-zinc-500">
            None: a word needs {MIN_SKIPS} skips for stack or seniority and must not appear in any job you kept.
          </p>
        )}
      </div>
    </div>
  );
}
