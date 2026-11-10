'use client';

import { type FormEvent, startTransition, useActionState } from 'react';
import type { TextFormState } from '@/lib/written-text';

/** What a form's server action answers: TextFormState, or a richer state with the same ok / message (SaveState). */
type FormState = { ok: boolean; message: string } | null;

/**
 * Submits through useActionState from onSubmit rather than <form action>, because React resets a form after an
 * action prop runs, which would wipe what the user typed when the action answers with an error.
 */
export function useFormState<S extends FormState>(action: (prev: S, fd: FormData) => Promise<S>) {
  const [state, dispatch, pending] = useActionState<S, FormData>(action, null as Awaited<S>);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(() => dispatch(fd));
  };
  // `action` is for the form's action prop: before hydration (or without JS) the form still posts to the server
  // action; once hydrated, onSubmit takes over and keeps the controls' values when the action answers an error.
  return { state, pending, onSubmit, action: dispatch };
}

/** useFormState for the one-click and text actions that answer with a TextFormState. */
export const useTextForm = (action: (prev: TextFormState, fd: FormData) => Promise<TextFormState>) => useFormState(action);

/**
 * The answer of a form's action, next to its button: a failure as an alert, a success's message (e.g. "Saved",
 * "Skipped 3 jobs") as a small status line. Nothing before the first answer, or for a success without a message.
 */
export function Problem({ state }: { state: FormState }) {
  if (!state || (state.ok && !state.message)) return null;
  if (state.ok)
    return (
      <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
        {state.message}
      </p>
    );
  return (
    <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
      {state.message}
    </p>
  );
}
