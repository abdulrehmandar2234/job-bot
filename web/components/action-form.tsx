'use client';

import type { ReactNode } from 'react';
import type { TextFormState } from '@/lib/written-text';
import { Problem, useTextForm } from './written-text';

type Action = (prev: TextFormState, fd: FormData) => Promise<TextFormState>;

/**
 * A form for a one-click server action that answers with a TextFormState instead of throwing: the error is
 * shown next to the button (role=alert, see <Problem>) and the page keeps the user's place, instead of being
 * replaced by app/error.tsx. Submits through useActionState from onSubmit (useTextForm), so extra controls
 * in `children` (a select, a textarea) keep what the user chose or typed when the action answers with an error.
 */
export function ActionForm({
  action,
  fields = {},
  children,
  label,
  pendingText,
  className = '',
  buttonClass = '',
  busy,
}: {
  action: Action;
  /** Hidden inputs, e.g. { id, status }. */
  fields?: Record<string, string | number>;
  /** Extra controls rendered before the button. */
  children?: ReactNode;
  label: ReactNode;
  pendingText?: string;
  className?: string;
  buttonClass?: string;
  /** Rendered in place of the submit button, e.g. <Busy> while the matching background task runs. */
  busy?: ReactNode;
}) {
  const { state, pending, onSubmit } = useTextForm(action);
  return (
    <form onSubmit={onSubmit} className={className}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {children}
      {busy ?? (
        <button type="submit" disabled={pending} className={`btn ${buttonClass} ${pending ? 'opacity-60 cursor-wait' : ''}`}>
          {pending ? (pendingText ?? '…') : label}
        </button>
      )}
      <Problem state={state} />
    </form>
  );
}
