'use client';

import { useEffect, useRef, useState } from 'react';
import { SETTINGS_GROUPS } from '@/lib/settings-sections';

/** How far below the top of the window a section's top must be scrolled to count as the one being read. */
export const ACTIVE_OFFSET = 96;

/**
 * The section being read: the last one whose top has scrolled past ACTIVE_OFFSET, the first one before any has, and
 * the last one once the page is scrolled to the bottom (a short last section never reaches the offset).
 */
export function activeSection(tops: { id: string; top: number }[], atBottom: boolean): string | undefined {
  if (!tops.length) return undefined;
  if (atBottom) return tops[tops.length - 1].id;
  let active = tops[0].id;
  for (const t of tops) if (t.top <= ACTIVE_OFFSET) active = t.id;
  return active;
}

const SECTION_IDS = SETTINGS_GROUPS.flatMap((g) => g.sections.map((s) => s.id));

const navLink = 'block rounded-r-lg border-l-2 py-1 pr-2.5 pl-2 transition-colors';
const idle =
  'border-transparent text-zinc-600 hover:border-zinc-300 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:border-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-100';
const current = 'border-zinc-900 bg-zinc-100 font-medium text-zinc-900 dark:border-zinc-100 dark:bg-zinc-900 dark:text-zinc-100';

/**
 * Links to every section: a sticky column on the left on large screens, a wrapped list of links above the forms on
 * small ones. The section in view is marked (aria-current) as the page scrolls, and kept visible in the nav's own
 * scroll area. Without JS these are plain anchors.
 */
export function SettingsNav() {
  const [active, setActive] = useState<string>();
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const tops = SECTION_IDS.flatMap((id) => {
        const el = document.getElementById(id);
        return el ? [{ id, top: el.getBoundingClientRect().top }] : [];
      });
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setActive(activeSection(tops, atBottom));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  // Keep the marked link in view when the nav itself scrolls (a short window on a large screen).
  useEffect(() => {
    const link = active && nav.current?.querySelector<HTMLElement>(`a[href="#${active}"]`);
    if (link && nav.current && nav.current.scrollHeight > nav.current.clientHeight) link.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  return (
    <nav
      ref={nav}
      aria-label="Settings sections"
      className="text-sm lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
        {SETTINGS_GROUPS.map((g) => {
          const inGroup = g.sections.some((s) => s.id === active);
          return (
            <div key={g.id}>
              <a
                href={`#${g.id}`}
                className={`mb-1 block px-2.5 text-xs font-semibold tracking-wide uppercase hover:underline ${inGroup ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'}`}
              >
                {g.title}
              </a>
              <ul className="flex flex-wrap gap-x-1 lg:block lg:space-y-0.5">
                {g.sections.map((s) => (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      aria-current={s.id === active ? 'location' : undefined}
                      className={`${navLink} ${s.id === active ? current : idle}`}
                    >
                      {s.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </nav>
  );
}
