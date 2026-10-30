import type { ReactNode } from 'react';

/**
 * A card that folds away behind its heading, so long blocks do not push the rest of the page down. A plain
 * <details>, so it needs no client JS. `title` is the heading's content: put the short summary that stays visible
 * (e.g. "· 3 of 8 keywords") in it, after the name.
 */
export function Collapsible({
  title,
  hint,
  id,
  open,
  children,
}: {
  title: ReactNode;
  /** A line under the heading that stays visible while folded, e.g. the AI's one-line verdict. */
  hint?: ReactNode;
  id?: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details id={id} open={open} className="group scroll-mt-4 rounded-xl border border-zinc-200 text-sm dark:border-zinc-800">
      <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded-xl p-3 hover:bg-zinc-50 dark:hover:bg-zinc-900 [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className="text-xs text-zinc-400 transition-transform group-open:rotate-90">
          ▶
        </span>
        <span className="block min-w-0 space-y-0.5">
          <h2 className="font-medium">{title}</h2>
          {hint && <span className="block text-zinc-600 dark:text-zinc-400">{hint}</span>}
        </span>
      </summary>
      <div className="space-y-2 px-3 pb-3">{children}</div>
    </details>
  );
}

/**
 * A long text shown as its first lines, with a "Show full <label>" toggle that unfolds `children` (the full text,
 * or an editor for it). The preview hides while open; CSS only (`peer-open`), so no client JS.
 */
export function FoldedText({ preview, label, children }: { preview: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <details className="group peer order-2">
        <summary className="mt-1 w-fit cursor-pointer list-none text-sm font-medium text-zinc-600 hover:underline dark:text-zinc-400 [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Show full {label}</span>
          <span className="hidden group-open:inline">Hide full {label}</span>
          <span aria-hidden="true" className="ml-1 inline-block text-xs transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="mt-2">{children}</div>
      </details>
      <p className="order-1 line-clamp-4 whitespace-pre-line text-sm leading-relaxed text-zinc-700 peer-open:hidden dark:text-zinc-300">
        {preview}
      </p>
    </div>
  );
}
