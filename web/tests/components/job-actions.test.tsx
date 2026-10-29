// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JobActions } from '@/components/job-actions';
import type { Job, Status } from '@/lib/db';

// Server actions are only referenced as form actions here; they are tested in tests/app/actions.test.ts.
vi.mock('@/app/actions', () => ({ setStatus: vi.fn(), prepare: vi.fn(), aiReview: vi.fn() }));

const job = (over: Partial<Job> = {}): Job => ({
  id: 'greenhouse:acme:1',
  source: 'greenhouse',
  company: 'Acme',
  title: 'Engineer',
  location: 'Dubai',
  country: 'AE',
  url: 'https://boards.greenhouse.io/acme/1',
  description: '',
  posted_at: null,
  first_seen_at: new Date(),
  score: 60,
  cluster: null,
  matched: [],
  missing: [],
  visa: null,
  flags: [],
  status: 'new',
  filter_reason: null,
  cv_version: null,
  cover_letter: null,
  applied_at: null,
  notes: null,
  ai_score: null,
  ai_verdict: null,
  ai_summary: null,
  ai_reasons: null,
  ai_gaps: null,
  ai_flags: null,
  salary_min: null,
  salary_max: null,
  salary_currency: null,
  salary_period: null,
  follow_ups: 0,
  followed_up_at: null,
  follow_up_draft: null,
  follow_up_draft_at: null,
  ...over,
});

const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent);

/** The status a "move" button submits, from the hidden input in its form. */
const targetOf = (label: string) => {
  const form = screen.getByRole('button', { name: label }).closest('form')!;
  return (form.querySelector('input[name="status"]') as HTMLInputElement).value;
};

describe('JobActions', () => {
  it('always links to the job posting', () => {
    render(<JobActions job={job()} />);
    const link = screen.getByRole('link', { name: 'Open job ↗' });
    expect(link).toHaveAttribute('href', 'https://boards.greenhouse.io/acme/1');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('offers prepare and AI review for an unprepared, unreviewed new job', () => {
    render(<JobActions job={job()} />);
    expect(buttons()).toEqual(['Prepare CV + letter', 'AI review', 'Mark applied ✓', 'Skip']);
    expect(targetOf('Mark applied ✓')).toBe('applied');
    expect(targetOf('Skip')).toBe('skipped');
  });

  it('puts the job id in every form', () => {
    const { container } = render(<JobActions job={job()} />);
    const ids = [...container.querySelectorAll('input[name="id"]')].map((i) => (i as HTMLInputElement).value);
    expect(ids).toHaveLength(4);
    expect(new Set(ids)).toEqual(new Set(['greenhouse:acme:1']));
  });

  it('links to the CV instead of preparing once a CV version exists', () => {
    render(<JobActions job={job({ status: 'prepared', cv_version: 'backend-lead' })} />);
    const cv = screen.getByRole('link', { name: 'CV (backend-lead)' });
    expect(cv).toHaveAttribute('href', '/api/cv/backend-lead');
    expect(screen.queryByRole('button', { name: /Prepare/ })).not.toBeInTheDocument();
    expect(buttons()).toEqual(['AI review', 'Mark applied ✓', 'Skip']);
  });

  it('hides AI review once the job has an AI score (including 0)', () => {
    render(<JobActions job={job({ ai_score: 0 })} />);
    expect(screen.queryByRole('button', { name: 'AI review' })).not.toBeInTheDocument();
  });

  it('says "Prepare anyway" for a filtered job and offers no status moves', () => {
    render(<JobActions job={job({ status: 'filtered' })} />);
    expect(buttons()).toEqual(['Prepare anyway', 'AI review']);
    expect(screen.getByRole('button', { name: 'Prepare anyway' }).closest('form')!.querySelector('input[name="force"]')).toBeNull();
  });

  it('offers "Prepare anyway" (forced past the open check) and "Move to matching" for an expired job', () => {
    render(<JobActions job={job({ status: 'expired', ai_score: 70 })} />);
    expect(buttons()).toEqual(['Prepare anyway', 'Move to matching']);
    const form = screen.getByRole('button', { name: 'Prepare anyway' }).closest('form')!;
    expect(form.querySelector('input[name="force"]')).toHaveValue('true');
    expect(targetOf('Move to matching')).toBe('new');
  });

  it.each<[Status, [string, string][]]>([
    [
      'new',
      [
        ['Mark applied ✓', 'applied'],
        ['Skip', 'skipped'],
      ],
    ],
    [
      'prepared',
      [
        ['Mark applied ✓', 'applied'],
        ['Skip', 'skipped'],
      ],
    ],
    [
      'applied',
      [
        ['Got interview', 'interview'],
        ['Rejected', 'rejected'],
      ],
    ],
    [
      'interview',
      [
        ['Offer 🎉', 'offer'],
        ['Rejected', 'rejected'],
      ],
    ],
    ['skipped', [['Move to matching', 'new']]],
    ['expired', [['Move to matching', 'new']]],
    ['offer', []],
    ['rejected', []],
  ])('status %s offers the right moves', (status, moves) => {
    render(<JobActions job={job({ status, cv_version: 'default', ai_score: 70 })} />);
    expect(buttons()).toEqual(moves.map(([label]) => label));
    for (const [label, to] of moves) expect(targetOf(label)).toBe(to);
  });

  it('styles the positive moves', () => {
    render(<JobActions job={job({ status: 'interview' })} />);
    expect(screen.getByRole('button', { name: 'Offer 🎉' })).toHaveClass('btn-good');
    expect(screen.getByRole('button', { name: 'Rejected' })).not.toHaveClass('btn-good');
  });
});
