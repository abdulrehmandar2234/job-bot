'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { addRoleExclude } from '@/app/settings/actions';
import type { Suggestion } from '@/lib/skip-insights';
import { SubmitButton } from './client';

/** "Add `\bprincipal\b` to roleExclude? (9 skips)". config.json changes only after the user confirms. */
export function SkipSuggestion({ s }: { s: Suggestion }) {
  const [state, action] = useActionState(addRoleExclude, null);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span>Add <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{s.pattern}</code> to roleExclude?{' '}
        <span className="text-zinc-500">({s.skips} skips)</span></span>
      <span className="flex items-center gap-2">
        {state && <span role="status" className={`text-xs ${state.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}>
          {state.message}</span>}
        {!state?.ok && (
          <form action={action} onSubmit={(e) => {
            if (!confirm(`Add ${s.pattern} to roleExclude in config.json? Jobs with "${s.word}" in the title will be filtered out.`)) e.preventDefault();
          }}>
            <input type="hidden" name="pattern" value={s.pattern} />
            <SubmitButton pendingText="Saving…">Add</SubmitButton>
          </form>
        )}
        <Link href="/settings" className="btn">Open settings</Link>
      </span>
    </li>
  );
}
