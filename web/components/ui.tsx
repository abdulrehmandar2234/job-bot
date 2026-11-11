import type { Status } from '@/lib/db';

// Typed on Status so a missing or renamed status fails the typecheck instead of rendering an empty label.
export const STATUS_LABEL: Record<Status, string> = {
  new: 'Matching',
  prepared: 'Prepared',
  applied: 'Applied',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  skipped: 'Skipped',
  expired: 'Expired',
  filtered: 'Filtered out',
};

const SOURCE_LABEL: Record<string, string> = {
  linkedin: 'LinkedIn',
  bayt: 'Bayt',
  himalayas: 'Himalayas',
  remotive: 'Remotive',
  remoteok: 'RemoteOK',
  arbeitnow: 'Arbeitnow',
  adzuna: 'Adzuna',
  jobicy: 'Jobicy',
  hackernews: 'Hacker News',
  manual: 'Added manually',
};
// Greenhouse, Lever, Ashby... are the company's own careers page.
const sourceLabel = (s: string) => SOURCE_LABEL[s] ?? 'Company site';

/** One tag per site the job is posted on, each linking to that posting. */
export function PostedOn({ postings }: { postings: { id: string; source: string; url: string }[] }) {
  if (!postings.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-zinc-500">Posted on:</span>
      {postings.map((p) => (
        <a
          key={p.id}
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="rounded-full border border-sky-300 px-2 py-0.5 text-sky-700 hover:bg-sky-50 dark:border-sky-800 dark:text-sky-300 dark:hover:bg-sky-950"
        >
          {sourceLabel(p.source)} ↗
        </a>
      ))}
    </div>
  );
}

export function fmtDate(d: Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function ago(d: Date | null) {
  if (!d) return 'never';
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** "Posted 2d ago (27 Oct)", green while fresh, so old postings stand out. */
export function Posted({ date }: { date: Date | null }) {
  if (!date) return <span>posted: unknown</span>;
  const days = Math.floor((Date.now() - new Date(date).getTime()) / 86_400_000);
  const tone = days <= 2 ? 'text-emerald-600 dark:text-emerald-400 font-medium' : days <= 7 ? '' : 'text-rose-600 dark:text-rose-400';
  return (
    <span className={tone}>
      posted {days === 0 ? '<24h ago' : `${days}d ago`} ({fmtDate(date)})
    </span>
  );
}

/** Shows the AI score when the job has one, else the keyword score. */
export function Score({ value, ai }: { value: number; ai?: number | null }) {
  const v = ai ?? value;
  // amber-700 keeps white text at ≥ 4.5:1 (WCAG AA); amber-500 was ~2:1 and unreadable.
  const tone = v >= 75 ? 'bg-emerald-600' : v >= 55 ? 'bg-amber-700' : 'bg-zinc-400 dark:bg-zinc-600';
  return (
    <span
      title={ai != null ? `AI score ${ai} · keyword score ${value}` : `Keyword score ${value} (not AI-reviewed yet)`}
      className={`inline-flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg font-semibold leading-none text-white ${tone}`}
    >
      <span className="text-sm">{v}</span>
      <span className="mt-0.5 text-[9px] font-medium uppercase opacity-80">{ai != null ? 'AI' : 'kw'}</span>
    </span>
  );
}

/** The AI's one-line verdict plus why it fits, what is missing and blockers. */
export function AiReview({
  job,
}: {
  job: {
    ai_score: number | null;
    ai_verdict: string | null;
    ai_summary: string | null;
    ai_reasons: string[] | null;
    ai_gaps: string[] | null;
    ai_flags: string[] | null;
  };
}) {
  if (job.ai_score == null) return null;
  return (
    <div className="space-y-1 rounded-lg bg-violet-50 p-2 text-sm dark:bg-violet-950/40">
      <p>
        <span className="font-medium text-violet-700 dark:text-violet-300">AI · {job.ai_verdict}:</span> {job.ai_summary}
      </p>
      <Chips items={(job.ai_reasons ?? []).map((r) => `✓ ${r}`)} tone="good" />
      <Chips items={(job.ai_gaps ?? []).map((g) => `– ${g}`)} tone="bad" />
      <Chips items={(job.ai_flags ?? []).map((f) => `⚠ ${f}`)} tone="warn" />
    </div>
  );
}

export function Chips({ items, tone }: { items: string[]; tone: 'good' | 'bad' | 'warn' }) {
  if (!items.length) return null;
  const cls = {
    good: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    bad: 'bg-rose-50 text-rose-800 dark:bg-rose-950 dark:text-rose-300',
    warn: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  }[tone];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((s) => (
        <span key={s} className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>
          {s}
        </span>
      ))}
    </div>
  );
}
