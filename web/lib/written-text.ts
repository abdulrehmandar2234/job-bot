import { FEEDBACK_CAP } from '../../src/types.ts';

// The cover letter and the CV summary on the job page: rewriting them with feedback, or editing them by hand.
// Plain values and checks, shared by the server actions (app/actions.ts) and the forms (components/written-text.tsx).

/** Longest feedback ("What should change?"): the bot's limit, which task:run checks again. */
export { FEEDBACK_CAP };
/** Longest text the user may save by hand. */
export const TEXT_CAP = { letter: 10_000, summary: 2_000, headline: 120 } as const;
export type WrittenKind = keyof typeof TEXT_CAP;

/** What the feedback and edit forms get back: `ok` and a message, or why not. The form keeps the typed text. */
export type TextFormState = { ok: boolean; message: string } | null;

/** The feedback from a form field, trimmed, or the reason it cannot be used. */
export function checkFeedback(value: unknown): { feedback: string } | { error: string } {
  if (typeof value !== 'string') return { error: 'Feedback must be text.' };
  if (value.length > FEEDBACK_CAP) return { error: `Feedback is too long: at most ${FEEDBACK_CAP} characters.` };
  const feedback = value.trim();
  if (!feedback) return { error: 'Write what should change first.' };
  return { feedback };
}

/**
 * Text the user typed, ready to store, or the reason it cannot be. Line breaks become \n (forms send \r\n); a letter
 * keeps its paragraphs and ends with one newline, as the bot writes it; a summary is one paragraph, a headline one line.
 */
export function checkText(kind: WrittenKind, value: unknown): { text: string } | { error: string } {
  const name = kind;
  if (typeof value !== 'string') return { error: `The ${name} must be text.` };
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (!text) return { error: `The ${name} is empty.` };
  if (text.length > TEXT_CAP[kind]) return { error: `The ${name} is too long: at most ${TEXT_CAP[kind]} characters.` };
  return { text: kind === 'letter' ? `${text}\n` : text.replace(/\s+/g, ' ') };
}
