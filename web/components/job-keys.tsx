'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { isTyping } from './triage';

/**
 * Keys on the job page, with the list page's rules (components/triage.tsx): j / k open the next / previous job of the
 * list the page was opened from, Esc goes back to that list, a marks the job applied and s moves into the skip-reason
 * select (Enter there skips, Esc backs out). Everything is off while typing in a field, and Esc is left to an open
 * dialog. The keys click or focus the page's own buttons (data-shortcut), so pending states and errors are shared.
 */
export function JobKeys({ prev, next, back }: { prev?: string | null; next?: string | null; back: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (isTyping(t)) {
        if (t?.tagName === 'SELECT' && t.dataset.shortcut === 's' && (e.key === 'Enter' || e.key === 'Escape')) {
          e.preventDefault();
          if (e.key === 'Enter') t.closest('form')?.requestSubmit();
          t.blur();
        }
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      const go = (href: string | null | undefined) => {
        if (!href) return;
        e.preventDefault();
        router.push(href);
      };
      switch (e.key) {
        case 'j':
          go(next);
          break;
        case 'k':
          go(prev);
          break;
        case 'Escape':
          go(back);
          break;
        case 'a':
          document.querySelector<HTMLElement>('[data-shortcut="a"]')?.click();
          break;
        case 's': {
          const select = document.querySelector<HTMLElement>('[data-shortcut="s"]');
          if (select) {
            e.preventDefault();
            select.focus();
          }
          break;
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [prev, next, back, router]);

  return (
    <p className="text-xs text-zinc-500 max-sm:hidden">
      Keys: {(prev || next) && <>j / k next / previous job · </>}a mark applied · s skip · Esc back to the list
    </p>
  );
}
