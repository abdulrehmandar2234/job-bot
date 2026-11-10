'use client';

import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { AiOffNote } from './ai-off';
import { Problem, useTextForm } from './form-state';
import { FEEDBACK_CAP, TEXT_CAP, type TextFormState, type WrittenKind } from '@/lib/written-text';

type Action = (prev: TextFormState, fd: FormData) => Promise<TextFormState>;

/**
 * Asks before the form inside it submits, for a click that destroys text the user wrote (a rewrite of an edited
 * letter, "Clear all" answers). With `when` false it does nothing. It catches the submit before the form's own
 * handler (capture phase), so a "Cancel" sends nothing; `display: contents` keeps the form's place in the layout.
 */
export function ConfirmFirst({ message, when = true, children }: { message: string; when?: boolean; children: ReactNode }) {
  const onSubmitCapture = (e: FormEvent) => {
    if (!when || window.confirm(message)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div className="contents" onSubmitCapture={onSubmitCapture}>
      {children}
    </div>
  );
}

const NAME: Record<WrittenKind, string> = { letter: 'cover letter', summary: 'CV summary', headline: 'CV headline' };

function EditForm({ id, kind, text, save, onDone }: { id: string; kind: WrittenKind; text: string; save: Action; onDone: () => void }) {
  const { state, pending, onSubmit } = useTextForm(save);
  useEffect(() => {
    if (state?.ok) onDone();
  }, [state, onDone]);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <textarea
        name="text"
        defaultValue={text}
        aria-label={`Edit ${NAME[kind]}`}
        maxLength={TEXT_CAP[kind]}
        rows={kind === 'letter' ? 16 : kind === 'headline' ? 2 : 4}
        className="input w-full font-sans text-sm"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={`btn btn-primary ${pending ? 'cursor-wait opacity-60' : ''}`}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn" onClick={onDone} disabled={pending}>
          Cancel
        </button>
        <Problem state={state} />
      </div>
    </form>
  );
}

function FeedbackForm({ id, rewrite }: { id: string; rewrite: Action }) {
  const { state, pending, onSubmit } = useTextForm(rewrite);
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input type="hidden" name="id" value={id} />
      <label className="block text-sm">
        <span className="font-medium">What should change?</span>
        <span className="ml-1 text-xs text-zinc-500">e.g. shorter, less formal, more about one project</span>
        <textarea name="feedback" maxLength={FEEDBACK_CAP} rows={2} className="input mt-1 w-full" />
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending} className={`btn ${pending ? 'cursor-wait opacity-60' : ''}`}>
          {pending ? 'Starting…' : 'Rewrite with feedback'}
        </button>
        <Problem state={state} />
        <span className="text-xs text-zinc-500">The AI keeps to your CV: it says so when it leaves something out.</span>
      </div>
    </form>
  );
}

/**
 * The cover letter or CV summary on the job page: the text, an Edit toggle that saves the user's own text with no
 * AI, and "What should change?" to have the AI rewrite it with feedback (only while the AI is on: `ai`). Both are
 * hidden while the bot rewrites it.
 */
export function WrittenText({
  id,
  kind,
  text,
  busy,
  save,
  rewrite,
  ai = true,
}: {
  id: string;
  kind: WrittenKind;
  text: string;
  busy: boolean;
  save: Action;
  rewrite: Action;
  ai?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditForm id={id} kind={kind} text={text} save={save} onDone={() => setEditing(false)} />;
  return (
    <div className="space-y-3">
      <pre className="whitespace-pre-wrap rounded-xl bg-zinc-50 p-4 font-sans text-sm dark:bg-zinc-900">{text}</pre>
      {!busy && (
        <>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          {ai ? <FeedbackForm id={id} rewrite={rewrite} /> : <AiOffNote what="rewriting with feedback" />}
        </>
      )}
    </div>
  );
}
