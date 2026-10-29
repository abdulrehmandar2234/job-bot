// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ago, AiReview, Chips, fmtDate, Posted, PostedOn, Score, STATUS_LABEL } from '@/components/ui';
import { STATUSES } from '@/lib/db';

const NOW = new Date('2026-10-29T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('labels', () => {
  it('has a label for every status', () => {
    for (const s of STATUSES) expect(STATUS_LABEL[s]).toBeTruthy();
    expect(STATUS_LABEL.new).toBe('Matching');
    expect(STATUS_LABEL.filtered).toBe('Filtered out');
  });
});

describe('PostedOn', () => {
  it('renders nothing without postings', () => {
    const { container } = render(<PostedOn postings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('links each posting with a site label, ATS boards shown as "Company site"', () => {
    const known = ['linkedin', 'bayt', 'himalayas', 'remotive', 'remoteok', 'manual'];
    const ats = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters'];
    const postings = [...known, ...ats].map((source) => ({ id: `${source}:1`, source, url: `https://${source}.example/job` }));
    render(<PostedOn postings={postings} />);

    expect(screen.getByText('Posted on:')).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual([
      'LinkedIn ↗',
      'Bayt ↗',
      'Himalayas ↗',
      'Remotive ↗',
      'RemoteOK ↗',
      'Added manually ↗',
      ...ats.map(() => 'Company site ↗'),
    ]);
    links.forEach((a, i) => {
      expect(a).toHaveAttribute('href', postings[i].url);
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noreferrer');
    });
  });
});

describe('fmtDate', () => {
  it('formats as "day month" and shows a dash for no date', () => {
    expect(fmtDate(new Date('2026-10-27T10:00:00Z'))).toBe('27 Oct');
    expect(fmtDate(null)).toBe('—');
  });

  it('accepts a date string from JSON', () => {
    expect(fmtDate('2026-01-05T10:00:00Z' as unknown as Date)).toBe('5 Jan');
  });
});

describe('ago', () => {
  it.each([
    [null, 'never'],
    [new Date(NOW.getTime() - 5 * 60_000), '5m ago'],
    [new Date(NOW.getTime() - 59 * 60_000), '59m ago'],
    [hoursAgo(1), '1h ago'],
    [hoursAgo(23), '23h ago'],
    [hoursAgo(24), '1d ago'],
    [hoursAgo(24 * 10), '10d ago'],
  ])('%s -> %s', (d, expected) => {
    expect(ago(d)).toBe(expected);
  });
});

describe('Posted', () => {
  it('says unknown without a date', () => {
    render(<Posted date={null} />);
    expect(screen.getByText('posted: unknown')).toBeInTheDocument();
  });

  it('shows <24h ago for today, in green', () => {
    render(<Posted date={hoursAgo(5)} />);
    const el = screen.getByText(/posted/);
    expect(el).toHaveTextContent('posted <24h ago (29 Oct)');
    expect(el).toHaveClass('text-emerald-600');
  });

  it('stays green up to 2 days', () => {
    render(<Posted date={hoursAgo(24 * 2 + 1)} />);
    const el = screen.getByText(/posted/);
    expect(el).toHaveTextContent('posted 2d ago (27 Oct)');
    expect(el).toHaveClass('text-emerald-600');
  });

  it('is neutral from 3 to 7 days', () => {
    for (const d of [3, 7]) {
      const { unmount } = render(<Posted date={hoursAgo(24 * d + 1)} />);
      const el = screen.getByText(/posted/);
      expect(el).toHaveTextContent(`posted ${d}d ago`);
      expect(el.className).toBe('');
      unmount();
    }
  });

  it('turns red after a week', () => {
    render(<Posted date={hoursAgo(24 * 8 + 1)} />);
    const el = screen.getByText(/posted/);
    expect(el).toHaveTextContent('posted 8d ago (21 Oct)');
    expect(el).toHaveClass('text-rose-600');
  });
});

describe('Score', () => {
  it('shows the keyword score labelled "kw" without an AI score', () => {
    const { container } = render(<Score value={62} />);
    const badge = container.firstElementChild!;
    expect(badge).toHaveTextContent('62kw');
    expect(badge).toHaveAttribute('title', 'Keyword score 62 (not AI-reviewed yet)');
    expect(badge).toHaveClass('bg-amber-500');
  });

  it('prefers the AI score, labelled "AI", and colours by it', () => {
    const { container } = render(<Score value={40} ai={80} />);
    const badge = container.firstElementChild!;
    expect(badge).toHaveTextContent('80AI');
    expect(badge).toHaveAttribute('title', 'AI score 80 · keyword score 40');
    expect(badge).toHaveClass('bg-emerald-600');
  });

  it('treats an AI score of 0 as reviewed', () => {
    const { container } = render(<Score value={90} ai={0} />);
    expect(container.firstElementChild).toHaveTextContent('0AI');
    expect(container.firstElementChild).toHaveClass('bg-zinc-400');
  });

  it.each([
    [75, 'bg-emerald-600'],
    [74, 'bg-amber-500'],
    [55, 'bg-amber-500'],
    [54, 'bg-zinc-400'],
  ])('score %i is %s', (v, cls) => {
    const { container } = render(<Score value={v} ai={null} />);
    expect(container.firstElementChild).toHaveClass(cls);
  });
});

describe('AiReview', () => {
  const base = {
    ai_score: 82,
    ai_verdict: 'strong',
    ai_summary: 'Good fit for the role',
    ai_reasons: ['Laravel'],
    ai_gaps: ['Go'],
    ai_flags: ['Onsite only'],
  };

  it('renders nothing for a job without an AI score', () => {
    const { container } = render(<AiReview job={{ ...base, ai_score: null }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows verdict, summary and the reasons, gaps and flags', () => {
    render(<AiReview job={base} />);
    expect(screen.getByText('AI · strong:')).toBeInTheDocument();
    expect(screen.getByText(/Good fit for the role/)).toBeInTheDocument();
    expect(screen.getByText('✓ Laravel')).toHaveClass('bg-emerald-50');
    expect(screen.getByText('– Go')).toHaveClass('bg-rose-50');
    expect(screen.getByText('⚠ Onsite only')).toHaveClass('bg-amber-50');
  });

  it('copes with null lists', () => {
    render(<AiReview job={{ ...base, ai_reasons: null, ai_gaps: null, ai_flags: null }} />);
    expect(screen.getByText('AI · strong:')).toBeInTheDocument();
    expect(screen.queryByText(/✓|–|⚠/)).not.toBeInTheDocument();
  });
});

describe('Chips', () => {
  it('renders nothing for an empty list', () => {
    const { container } = render(<Chips items={[]} tone="good" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders one chip per item in the tone colour', () => {
    render(<Chips items={['a', 'b']} tone="warn" />);
    expect(screen.getByText('a')).toHaveClass('bg-amber-50');
    expect(screen.getByText('b')).toHaveClass('bg-amber-50');
  });
});
