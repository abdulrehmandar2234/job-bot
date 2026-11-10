'use client';

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { SaveState } from '@/app/settings/actions';
import { useFormState } from '@/components/form-state';
import { errorsFor, type SettingsError } from '@/lib/settings-form';
import { type SettingsSectionId, sectionTitle } from '@/lib/settings-sections';

// The building blocks every Settings form shares: the save hook, fields, sections and the save bar.

type Action = (prev: SaveState, fd: FormData) => Promise<SaveState>;

/**
 * Warns before the page is left (reload, close, another site) while `dirty`: the browser shows its own "Leave
 * site?" dialog. The listener is removed once the edits are saved.
 */
function useLeaveWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers show the dialog only with returnValue set
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
}

/**
 * A Settings form's save (the shared useFormState, so a rejected save keeps the edits) plus its field errors and
 * unsaved-changes tracking: `onEdit` marks the form edited (the form's onChange, and the row editors' add / remove),
 * which warns before leaving the page until a save of those edits succeeds. Edits made while a save runs stay unsaved.
 */
export function useSave(action: Action) {
  const form = useFormState(action);
  const { state } = form;
  const [edits, setEdits] = useState(0);
  const [saved, setSaved] = useState(0);
  const submitted = useRef(0);
  useEffect(() => {
    if (state?.ok) setSaved(submitted.current);
  }, [state]);
  useLeaveWarning(edits > saved);
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    submitted.current = edits;
    form.onSubmit(e);
  };
  return { state, pending: form.pending, onSubmit, onEdit: () => setEdits((n) => n + 1), errors: state?.errors ?? [] };
}

/** "Saved" / the error summary, next to the save button. */
export function SaveStatus({ state, pending }: { state: SaveState; pending: boolean }) {
  if (pending) return <span className="text-sm text-zinc-500">Saving…</span>;
  if (!state) return null;
  if (state.ok)
    return (
      <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
        {state.message}
      </span>
    );
  return (
    <div role="alert" className="text-sm text-rose-700 dark:text-rose-400">
      <p className="font-medium">{state.message}</p>
      {state.errors.length > 0 && (
        <ul className="list-disc pl-5">
          {state.errors.map((e, i) => (
            <li key={i}>
              <code>{e.path}</code>: {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FieldErrors({ errors }: { errors: SettingsError[] }) {
  if (!errors.length) return null;
  return <p className="mt-1 text-xs text-rose-700 dark:text-rose-400">{errors.map((e) => e.message).join('; ')}</p>;
}

export function Field({
  label,
  name,
  errors,
  hint,
  children,
}: {
  label: string;
  name: string;
  errors: SettingsError[];
  hint?: string;
  children: ReactNode;
}) {
  const own = errorsFor(errors, name);
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children
    <label className="block text-sm" data-invalid={own.length > 0 || undefined}>
      <span className="font-medium">{label}</span>
      {hint && <span className="ml-1 text-xs text-zinc-500">{hint}</span>}
      <div className="mt-1">{children}</div>
      <FieldErrors errors={own} />
    </label>
  );
}

export const input = 'input w-full';
export const text = (v: unknown) => (v == null ? '' : String(v));
export const lines = (v: unknown) => (Array.isArray(v) ? v.join('\n') : '');

/** One card of the Settings page; its id (the section nav's anchor) and title come from lib/settings-sections.ts. */
export function Section({ id, children }: { id: SettingsSectionId; children: ReactNode }) {
  return (
    <fieldset id={id} className="scroll-mt-4 space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <legend className="px-1 text-sm font-semibold">{sectionTitle(id)}</legend>
      {children}
    </fieldset>
  );
}

export function Check({ label, name, value }: { label: string; name: string; value: unknown }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={value === true} /> {label}
    </label>
  );
}

/**
 * The save button and its status. `sticky` keeps it at the bottom of the window while its (long) form is on screen, so
 * the button and the result of a save are always in view; it scrolls away with the form.
 */
export function SaveBar({ label, state, pending, sticky }: { label: string; state: SaveState; pending: boolean; sticky?: boolean }) {
  const stick = sticky
    ? 'sticky bottom-0 z-10 max-h-[40vh] overflow-y-auto rounded-xl border border-zinc-200 bg-background/95 p-3 backdrop-blur dark:border-zinc-800'
    : '';
  return (
    <div data-testid="save-bar" className={`flex flex-wrap items-start gap-3 ${stick}`}>
      <button type="submit" disabled={pending} className={`btn btn-primary ${pending ? 'cursor-wait opacity-60' : ''}`}>
        {label}
      </button>
      <SaveStatus state={state} pending={pending} />
    </div>
  );
}
