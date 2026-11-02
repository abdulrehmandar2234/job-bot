'use client';

import { FEEDBACK_CAP, type TextFormState } from '@/lib/written-text';
import { Problem, useTextForm } from './written-text';

type Action = (prev: TextFormState, fd: FormData) => Promise<TextFormState>;

/**
 * The job's keywords that are not on the master CV, each with "I have this", plus a note for the AI. Ticked skills
 * are added to the master CV (`bot cv:feedback --add-skills`); unticked ones never go on a CV.
 */
export function MissingSkills({ id, missing, add }: { id: string; missing: string[]; add: Action }) {
  const { state, pending, onSubmit } = useTextForm(add);
  if (state?.ok)
    return (
      <p role="status" className="text-sm text-zinc-500">
        {state.message}
      </p>
    );
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <fieldset>
        <legend className="text-zinc-500">Not on your CV. Tick only the ones you have really used:</legend>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          {missing.map((s) => (
            <label key={s} className="inline-flex items-center gap-1.5">
              <input type="checkbox" name="skill" value={s} />
              {s}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="font-medium">Anything the AI should know?</span>
        <span className="ml-1 text-xs text-zinc-500">optional, e.g. used Docker for local setup and CI at my last job</span>
        <textarea name="feedback" maxLength={FEEDBACK_CAP} rows={2} className="input mt-1 w-full" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={`btn ${pending ? 'cursor-wait opacity-60' : ''}`}>
          {pending ? 'Starting…' : 'Add to my CV and improve it for this job'}
        </button>
        <Problem state={state} />
      </div>
      <p className="text-xs text-zinc-500">
        Ticked skills go on your master CV (a copy of it is kept first), so later CVs can show them too. Unticked ones stay off your CV. You
        get a new CV version for this job.
      </p>
    </form>
  );
}
