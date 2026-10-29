'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormStatus } from 'react-dom';

// Loads the Bayt collector from this dashboard into the current bayt.com tab.
const BAYT_BOOKMARKLET = `javascript:(()=>{if(!/(^|\\.)bayt\\.com$/.test(location.hostname)){alert('Open bayt.com first, then click this bookmark.');return}const s=document.createElement('script');s.src='http://localhost:3100/api/bayt-script?'+Date.now();document.body.appendChild(s)})()`;

/** A link to drag to the bookmarks bar. React refuses javascript: hrefs in JSX, so the href is set after mount. */
export function BaytBookmarklet() {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { ref.current?.setAttribute('href', BAYT_BOOKMARKLET); }, []);
  return (
    <a ref={ref} onClick={(e) => { e.preventDefault(); alert('Drag this button to your bookmarks bar, then click it on bayt.com.'); }}
      className="btn cursor-grab border-dashed">⇱ Bayt → Job Bot</a>
  );
}

export function SubmitButton({ children, pendingText, className = '' }:
  { children: React.ReactNode; pendingText?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`btn ${className} ${pending ? 'opacity-60 cursor-wait' : ''}`}>
      {pending ? pendingText ?? '…' : children}
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
