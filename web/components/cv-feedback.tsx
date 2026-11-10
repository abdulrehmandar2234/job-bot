'use client';

import { useState } from 'react';
import { FEEDBACK_CAP, type TextFormState } from '@/lib/written-text';
import { Problem, useTextForm } from './form-state';

type Action = (prev: TextFormState, fd: FormData) => Promise<TextFormState>;

/**
 * "What should change in this CV?" with "Improve CV with feedback" (`bot cv:feedback`), and the AI's suggestions
 * ("Suggest improvements") with "Use as feedback", which copies them into the box to edit before sending.
 */
export function CvFeedback({ id, review, busy, improve }: { id: string; review: string | null; busy: boolean; improve: Action }) {
  const [text, setText] = useState('');
  const { state, pending, onSubmit } = useTextForm(improve);
  return (
    <div className="space-y-3">
      {review && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Suggestions for this CV</h3>
          <pre className="whitespace-pre-wrap rounded-xl bg-zinc-50 p-3 font-sans text-sm dark:bg-zinc-900">{review}</pre>
          {!busy && (
            <button type="button" className="btn" onClick={() => setText(review.slice(0, FEEDBACK_CAP))}>
              Use as feedback
            </button>
          )}
        </div>
      )}
      {!busy && (
        <form onSubmit={onSubmit} className="space-y-2">
          <input type="hidden" name="id" value={id} />
          <label className="block text-sm">
            <span className="font-medium">What should change in this CV?</span>
            <span className="ml-1 text-xs text-zinc-500">e.g. summary too generic, put my main framework first, fit on one page</span>
            <textarea
              name="feedback"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={FEEDBACK_CAP}
              rows={3}
              className="input mt-1 w-full"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={pending} className={`btn ${pending ? 'cursor-wait opacity-60' : ''}`}>
              {pending ? 'Starting…' : 'Improve CV with feedback'}
            </button>
            <Problem state={state} />
            <span className="text-xs text-zinc-500">
              The AI only reorders, shortens or rewords what is in your master CV; anything new is left out. You get a new CV version.
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
