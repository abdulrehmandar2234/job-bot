import Link from 'next/link';

/** The page numbers to show: the first, the last, and two around the current one, with null for a gap. */
export function pageNumbers(page: number, pages: number): (number | null)[] {
  const keep = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2].filter((n) => n >= 1 && n <= pages));
  const out: (number | null)[] = [];
  for (const n of [...keep].sort((a, b) => a - b)) {
    const last = out.at(-1);
    // A gap of one page shows that page instead of "…".
    if (typeof last === 'number' && n - last === 2) out.push(last + 1);
    else if (typeof last === 'number' && n - last > 2) out.push(null);
    out.push(n);
  }
  return out;
}

/** "26–50 of 512 jobs" and page links. Renders nothing when everything fits on one page. */
export function Pager({ page, total, pageSize, href }: { page: number; total: number; pageSize: number; href: (page: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize && page === 1) return null;
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
  const step = (n: number, label: string) =>
    n >= 1 && n <= pages ? (
      <Link href={href(n)} className="btn">
        {label}
      </Link>
    ) : (
      <span className="btn cursor-not-allowed opacity-40" aria-disabled="true">
        {label}
      </span>
    );

  return (
    <nav aria-label="Pages" className="my-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-zinc-500">{page > pages ? `Page ${page} is past the end` : `${from}–${to} of ${total} jobs`}</span>
      <div className="flex flex-wrap items-center gap-1">
        {step(Math.min(page - 1, pages), '← Previous')}
        {pageNumbers(Math.min(page, pages), pages).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} className="px-1 text-zinc-400">
              …
            </span>
          ) : n === page ? (
            <span key={n} aria-current="page" className="btn btn-primary">
              {n}
            </span>
          ) : (
            <Link key={n} href={href(n)} className="btn">
              {n}
            </Link>
          ),
        )}
        {step(page + 1, 'Next →')}
      </div>
    </nav>
  );
}
