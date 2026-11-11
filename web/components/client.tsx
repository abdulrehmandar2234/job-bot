'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

// Loads the Bayt collector from this dashboard into the current bayt.com tab. Built from the dashboard's own
// origin (window.location.origin, set after mount), so the dashboard keeps working on any port, not just 3100.
const baytBookmarklet = (dashboard: string) =>
  `javascript:(()=>{if(!/(^|\\.)bayt\\.com$/.test(location.hostname)){alert('Open bayt.com first, then click this bookmark.');return}const s=document.createElement('script');s.src='${dashboard}/api/bayt-script?'+Date.now();document.body.appendChild(s)})()`;

/** A link to drag to the bookmarks bar (biome.json exempts it from the anchor a11y rules: it is a drag target). React refuses javascript: hrefs in JSX, so the href is set after mount. */
export function BaytBookmarklet() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    ref.current?.setAttribute('href', baytBookmarklet(window.location.origin));
  }, []);
  return (
    <a
      ref={ref}
      onClick={(e) => {
        e.preventDefault();
        alert('Drag this button to your bookmarks bar, then click it on bayt.com.');
      }}
      className="btn cursor-grab border-dashed"
    >
      ⇱ Bayt → Talaash
    </a>
  );
}

export function SubmitButton({
  children,
  pendingText,
  className = '',
}: {
  children: React.ReactNode;
  pendingText?: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`btn ${className} ${pending ? 'opacity-60 cursor-wait' : ''}`}>
      {pending ? (pendingText ?? '…') : children}
    </button>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);
  return (
    <button
      type="button"
      className="btn"
      onClick={async () => {
        // The clipboard API is missing on plain http (non-localhost) and rejects when the page is not focused.
        try {
          await navigator.clipboard.writeText(text);
          setResult('copied');
        } catch {
          setResult('failed');
        }
        setTimeout(() => setResult(null), 1500);
      }}
    >
      {result === 'copied' ? 'Copied ✓' : result === 'failed' ? 'Copy failed' : label}
    </button>
  );
}

/**
 * Refreshes the page when a background task finishes. Polls /api/tasks every few seconds, only while `active`
 * (the ids the server rendered as running) is non-empty; when the active set changes it calls router.refresh()
 * and stops. The refreshed page renders a new `active`, which starts polling again if anything is still running.
 */
export function TaskWatcher({ active, job, intervalMs = 3000 }: { active: number[]; job?: string; intervalMs?: number }) {
  const router = useRouter();
  const key = active.join(',');
  useEffect(() => {
    if (!key) return;
    let stopped = false;
    const url = `/api/tasks${job ? `?job=${encodeURIComponent(job)}` : ''}`;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        const { active: now } = (await res.json()) as { active: number[] };
        if (stopped || now.join(',') === key) return;
        stopped = true;
        clearInterval(timer);
        router.refresh();
      } catch {
        // Dev server restarting or offline: try again on the next tick.
      }
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [key, job, intervalMs, router]);
  return null;
}
