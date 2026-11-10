'use client';

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SKIP_LABEL, SKIP_REASONS } from '@/lib/skips';
import type { TextFormState } from '@/lib/written-text';
import { Problem, useTextForm } from './form-state';

type SkipAction = (prev: TextFormState, fd: FormData) => Promise<TextFormState>;

/** Whether a key press goes to a text field, select or editable element (typing takes every key there). */
export const isTyping = (t: EventTarget | null) =>
  ['INPUT', 'TEXTAREA', 'SELECT'].includes((t as HTMLElement | null)?.tagName ?? '') ||
  Boolean((t as HTMLElement | null)?.isContentEditable);

/**
 * Keyboard-first triage for the job list, plus bulk skip. The list itself is a server component, so this small
 * client layer works on the rendered cards: each <li> carries data-job-id and tabIndex=-1 (app/page.tsx), and the
 * actions inside a card are found by data-shortcut, which job-actions.tsx / skip-button.tsx put on the real
 * buttons — a key press clicks the same button the mouse would, so pending states and inline errors are shared.
 *
 * Keys (see KEYS below; ? shows them): j/k or the arrows move a visible focus between cards, Enter opens the
 * posting, o the job page, a marks applied, p prepares, s moves into the card's skip-reason select (Enter there
 * confirms the skip, Escape comes back). The action keys only work while focus is inside a card, so they always hit
 * the card the user sees highlighted; when a refresh removes the focused card (marked applied, skipped), focus moves
 * to the card that took its place. Where `selectable` (the Matching and Prepared tabs, app/page.tsx), x selects the
 * focused card and shift-click selects a range; the bar at the bottom then skips them all with one optional reason
 * (the `skip` server action, app/actions.ts skipSelected). Everything is off while an input, select or textarea has
 * focus, so typing in the filters never triggers actions.
 */
export function Triage({ ids, skip, selectable }: { ids: readonly string[]; skip: SkipAction; selectable: boolean }) {
  const [selected, setSelected] = useState<readonly string[]>([]);
  // What the last bulk skip answered ("Skipped 3 jobs ..."): the bar closes on success, so the page says it instead.
  const [notice, setNotice] = useState<string | undefined>();
  const clearAfterSkip = useCallback((message?: string) => {
    setSelected([]);
    setNotice(message);
  }, []);
  useEffect(() => {
    if (selected.length > 0) setNotice(undefined);
  }, [selected.length]);
  const [help, setHelp] = useState(false);
  // The focused card (index into ids) and the last card selected with x, the start of a shift-click range.
  const cursor = useRef(-1);
  const anchor = useRef(-1);
  // The id of the card focus was last in, to notice when a refresh removes it.
  const focused = useRef<string | null>(null);

  const card = useCallback(
    (i: number) => (ids[i] ? document.querySelector<HTMLElement>(`[data-job-id="${CSS.escape(ids[i])}"]`) : null),
    [ids],
  );

  const focusCard = useCallback(
    (i: number) => {
      const el = card(i);
      if (!el) return;
      cursor.current = i;
      el.focus();
      el.scrollIntoView?.({ block: 'nearest' });
    },
    [card],
  );

  // Selection is painted onto the server-rendered cards: data-selected styles the <li> (app/page.tsx). A layout
  // effect, so the highlight changes in the same commit as the bulk-skip bar instead of one frame later.
  useLayoutEffect(() => {
    for (let i = 0; i < ids.length; i++) {
      const el = card(i);
      if (!el) continue;
      if (selected.includes(ids[i])) el.dataset.selected = 'true';
      else delete el.dataset.selected;
    }
  }, [ids, selected, card]);

  // After a refresh the cards may have changed. If the focused card is still there, the cursor follows it (a card
  // above it may have left). If it left (marked applied, skipped), focus fell to <body>: move it to the card now in
  // its place, so the next key acts on a card the user can see. A layout effect, so no frame shows a lost focus.
  useLayoutEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    const inCard = (active?.closest?.('[data-job-id]') as HTMLElement | null)?.dataset.jobId;
    if (inCard && ids.includes(inCard)) cursor.current = ids.indexOf(inCard);
    else if (focused.current && !ids.includes(focused.current) && (!active || active === document.body) && ids.length)
      focusCard(Math.min(Math.max(cursor.current, 0), ids.length - 1));
    if (cursor.current >= ids.length) cursor.current = ids.length - 1;
    if (anchor.current >= ids.length) anchor.current = -1;
  }, [ids, focusCard]);

  // A new page or filter change renders other cards: drop selected ids that are no longer shown, and everything
  // when the list is not selectable (a tab where a bulk skip makes no sense).
  useEffect(() => {
    setSelected((sel) => {
      const kept = selectable ? sel.filter((id) => ids.includes(id)) : [];
      return kept.length === sel.length ? sel : kept;
    });
  }, [ids, selectable]);

  useEffect(() => {
    const indexOf = (target: EventTarget | null) => {
      const el = (target as HTMLElement | null)?.closest?.('[data-job-id]') as HTMLElement | null;
      return el?.dataset.jobId ? ids.indexOf(el.dataset.jobId) : -1;
    };
    const toggle = (i: number) => {
      anchor.current = i;
      setSelected((sel) => (sel.includes(ids[i]) ? sel.filter((id) => id !== ids[i]) : [...sel, ids[i]]));
    };

    // Clicking or tabbing into a card makes it the focused one, so the keys carry on from there.
    const onFocusIn = (e: FocusEvent) => {
      const i = indexOf(e.target);
      if (i >= 0) cursor.current = i;
      focused.current = i >= 0 ? ids[i] : null;
    };

    const onClick = (e: MouseEvent) => {
      if (!e.shiftKey || !selectable) return;
      // Shift-click on a link or control keeps its own meaning (open in a new window, ...).
      if ((e.target as HTMLElement | null)?.closest?.('a, button, select, input, textarea, label')) return;
      const to = indexOf(e.target);
      if (to < 0) return;
      e.preventDefault(); // no text selection from the shift-click
      const from = anchor.current >= 0 ? anchor.current : to;
      const range = ids.slice(Math.min(from, to), Math.max(from, to) + 1);
      setSelected((sel) => [...sel, ...range.filter((id) => !sel.includes(id))]);
      cursor.current = to;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) {
        // Typing takes every key. The one exception is the skip-reason select a card's `s` moved into:
        // Enter skips with the chosen reason (the same form the Skip button submits), Escape backs out.
        if (tag === 'SELECT' && t?.dataset.shortcut === 's' && (e.key === 'Enter' || e.key === 'Escape')) {
          e.preventDefault();
          if (e.key === 'Enter') t.closest('form')?.requestSubmit();
          focusCard(cursor.current);
        }
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelp((h) => !h);
        return;
      }
      if (e.key === 'Escape') {
        if (help) setHelp(false);
        else setSelected([]);
        return;
      }
      // The action keys act on the card focus is in, and on nothing when focus is elsewhere (on <body> after a
      // click on the page background): never on a card the user cannot see highlighted.
      const at = indexOf(document.activeElement);
      const trigger = (key: string) => (at >= 0 ? card(at)?.querySelector<HTMLElement>(`[data-shortcut="${key}"]`)?.click() : undefined);
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault();
          focusCard(Math.min(cursor.current + 1, ids.length - 1));
          break;
        case 'k':
        case 'ArrowUp':
          e.preventDefault();
          focusCard(Math.max(cursor.current - 1, 0));
          break;
        case 'Enter':
          // A focused button or link handles Enter itself.
          if (!t?.closest?.('a,button')) trigger('enter');
          break;
        case 'o':
          trigger('o');
          break;
        case 'a':
          trigger('a');
          break;
        case 'p':
          trigger('p');
          break;
        case 's':
          if (at >= 0) card(at)?.querySelector<HTMLElement>('[data-shortcut="s"]')?.focus();
          break;
        case 'x':
          if (selectable && at >= 0) toggle(at);
          break;
      }
    };

    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [ids, help, selectable, card, focusCard]);

  if (ids.length === 0) return null;
  return (
    <>
      <p className="mt-4 text-center text-xs text-zinc-500 max-sm:hidden">
        Keyboard triage: <Kbd>j</Kbd>/<Kbd>k</Kbd> move ·{' '}
        {selectable ? (
          <>
            <Kbd>x</Kbd> selects for bulk skip
          </>
        ) : (
          <>
            <Kbd>a</Kbd>, <Kbd>p</Kbd>, <Kbd>s</Kbd> act on the focused job
          </>
        )}{' '}
        · <Kbd>?</Kbd> shows every shortcut
      </p>
      {selectable && selected.length > 0 && <BulkBar selected={selected} skip={skip} onClear={clearAfterSkip} />}
      {notice && selected.length === 0 && (
        <p role="status" className="mt-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
          {notice}
        </p>
      )}
      {help && <Help selectable={selectable} onClose={() => setHelp(false)} />}
    </>
  );
}

/** Skips every selected card in one go, with the same optional reason the per-card Skip offers. */
function BulkBar({ selected, skip, onClear }: { selected: readonly string[]; skip: SkipAction; onClear: (message?: string) => void }) {
  const { state, pending, onSubmit } = useTextForm(skip);
  const done = state?.ok;
  const message = state?.ok ? state.message : undefined;
  useEffect(() => {
    if (done) onClear(message);
  }, [done, message, onClear]);
  return (
    <form
      onSubmit={onSubmit}
      aria-label="Bulk skip"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-zinc-300 bg-white px-4 py-2 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      {selected.map((id) => (
        <input key={id} type="hidden" name="id" value={id} />
      ))}
      <span className="font-medium">{selected.length} selected</span>
      <select
        name="reason"
        defaultValue=""
        aria-label="Skip reason for all selected (optional)"
        className="input py-1 text-xs text-zinc-500"
      >
        <option value="">why? (optional)</option>
        {SKIP_REASONS.map((r) => (
          <option key={r} value={r}>
            {SKIP_LABEL[r]}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={`btn ${pending ? 'opacity-60 cursor-wait' : ''}`}>
        {pending ? 'Skipping…' : 'Skip selected'}
      </button>
      <button type="button" className="btn" onClick={() => onClear()} disabled={pending}>
        Clear
      </button>
      <Problem state={state} />
    </form>
  );
}

// `bulk` marks the keys that only work where the list is selectable (the Matching and Prepared tabs).
const KEYS: readonly { key: string; what: string; bulk?: true }[] = [
  { key: 'j / ↓', what: 'Next job' },
  { key: 'k / ↑', what: 'Previous job' },
  { key: 'Enter', what: 'Open the posting ↗' },
  { key: 'o', what: 'Open the job page' },
  { key: 'a', what: 'Mark applied' },
  { key: 'p', what: 'Prepare CV (or download it)' },
  { key: 's', what: 'Skip: pick a reason, Enter confirms, Esc backs out' },
  { key: 'x', what: 'Select for bulk skip', bulk: true },
  { key: 'Shift+click', what: 'Select a range', bulk: true },
  { key: 'Esc', what: 'Clear the selection / close this', bulk: true },
  { key: 'Esc', what: 'Close this' },
  { key: '?', what: 'Show or hide this list' },
];

function Help({ selectable, onClose }: { selectable: boolean; onClose: () => void }) {
  // Esc has two rows: the one that mentions the selection where there is one, the other elsewhere.
  const keys = KEYS.filter((k) => (selectable ? !(k.key === 'Esc' && !k.bulk) : !k.bulk));
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="fixed right-4 bottom-4 z-50 w-80 max-w-full rounded-xl border border-zinc-300 bg-white p-4 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Keyboard shortcuts</h2>
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
      <dl className="space-y-1 text-sm">
        {keys.map(({ key, what }) => (
          <div key={key} className="flex items-baseline justify-between gap-3">
            <dt className="whitespace-nowrap">
              <Kbd>{key}</Kbd>
            </dt>
            <dd className="text-right text-zinc-500">{what}</dd>
          </div>
        ))}
      </dl>
      {!selectable && (
        <p className="mt-2 text-xs text-zinc-500">
          Bulk skip (<Kbd>x</Kbd>, <Kbd>Shift</Kbd>+click) works in the Matching and Prepared tabs.
        </p>
      )}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-zinc-300 px-1 font-sans dark:border-zinc-700">{children}</kbd>;
}
