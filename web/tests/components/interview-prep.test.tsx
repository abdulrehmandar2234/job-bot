// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { InterviewPrep, prepText } from '@/components/interview-prep';
import type { InterviewPrep as Prep, Job } from '@/lib/db';

// The action is only referenced as a form action here; it is tested in tests/app/jobs/interview-actions.test.ts.
vi.mock('@/app/jobs/[id]/interview-actions', () => ({ prepareInterview: vi.fn() }));

const PREP: Prep = {
  technical: [{ question: 'How do you scale a Laravel queue?', hint: 'Horizon work at Abyan Capital' }],
  behavioural: [
    { question: 'Tell me about a conflict.', situation: 'Two teams', task: 'Agree an API', action: 'Ran a review', result: 'Shipped' },
  ],
  company: { brief: 'Acme builds payment APIs.', verify: ['Verify before interview: office location'] },
  questions_to_ask: ['How do you review code?', 'What does on-call look like?'],
  requirements: [
    { requirement: 'Laravel', evidence: '7 years of Laravel', gap: false },
    { requirement: 'Kubernetes', evidence: 'not in the CV', gap: true },
  ],
};

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
  visa_evidence: null,
  flags: [],
  status: 'interview',
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
  ai_location: null,
  ai_location_reason: null,
  followed_up_at: null,
  follow_up_draft: null,
  follow_up_draft_at: null,
  deadline: null,
  cover_letter_check: null,
  ...over,
});

const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent);

describe('InterviewPrep', () => {
  it.each(['new', 'prepared', 'offer', 'rejected', 'skipped'] as const)('renders nothing for a %s job without prep', (status) => {
    const { container } = render(<InterviewPrep job={job({ status })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each(['applied', 'interview'] as const)('offers "Prepare for interview" for an %s job without prep', (status) => {
    render(<InterviewPrep job={job({ status })} />);
    expect(screen.getByRole('heading', { name: /Interview prep/ })).toBeInTheDocument();
    expect(buttons()).toEqual(['Prepare for interview']);
    const form = screen.getByRole('button', { name: 'Prepare for interview' }).closest('form')!;
    expect(form.querySelector('input[name="id"]')).toHaveValue('greenhouse:acme:1');
  });

  it('renders the stored prep with copy buttons and Regenerate', () => {
    render(<InterviewPrep job={job({ interview_prep: PREP, interview_prep_at: new Date('2026-10-20T10:00:00Z') })} />);
    expect(screen.getByText(/20 Oct/)).toBeInTheDocument();
    expect(screen.getByText('How do you scale a Laravel queue?')).toBeInTheDocument();
    expect(screen.getByText(/Horizon work at Abyan Capital/)).toBeInTheDocument();
    expect(screen.getByText(/Situation: Two teams\s+Task: Agree an API\s+Action: Ran a review\s+Result: Shipped/)).toBeInTheDocument();
    expect(screen.getByText('Acme builds payment APIs.')).toBeInTheDocument();
    expect(screen.getByText('Verify before interview: office location')).toBeInTheDocument();
    expect(screen.getByText('What does on-call look like?')).toBeInTheDocument();
    const gap = screen.getByText('Kubernetes').closest('li')!;
    expect(gap).toHaveTextContent('✗ Kubernetes: gap — not in the CV');
    expect(screen.getByText('Laravel').closest('li')).toHaveTextContent('✓ Laravel: 7 years of Laravel');
    // Regenerate, Copy all, then one Copy per question, the brief and the questions to ask.
    expect(buttons()).toEqual(['Regenerate', 'Copy all', 'Copy', 'Copy', 'Copy', 'Copy']);
  });

  it('shows "Preparing interview notes…" in place of the button while a prep task runs', () => {
    render(<InterviewPrep job={job({ interview_prep: PREP })} busy={['prepare', 'prep']} />);
    expect(screen.getByRole('status')).toHaveTextContent('Preparing interview notes…');
    expect(buttons()).not.toContain('Regenerate');
    expect(buttons()).toContain('Copy all');
  });

  it('keeps the button while only other tasks run', () => {
    render(<InterviewPrep job={job()} busy={['prepare', 'ai_review']} />);
    expect(buttons()).toEqual(['Prepare for interview']);
  });

  it('still shows a stored prep after the job moved on (e.g. offer)', () => {
    render(<InterviewPrep job={job({ status: 'offer', interview_prep: PREP })} />);
    expect(
      within(screen.getByRole('heading', { name: /Interview prep/ }).closest('section')!).getByRole('button', { name: 'Regenerate' }),
    ).toBeInTheDocument();
  });

  it('prepText puts every part into one plain-text copy', () => {
    const t = prepText(PREP);
    expect(t).toContain('TECHNICAL QUESTIONS\n- How do you scale a Laravel queue?\n  Emphasise: Horizon work at Abyan Capital');
    expect(t).toContain(
      '- Tell me about a conflict.\n  Situation: Two teams\n  Task: Agree an API\n  Action: Ran a review\n  Result: Shipped',
    );
    expect(t).toContain('COMPANY BRIEF\nAcme builds payment APIs.\n- Verify before interview: office location');
    expect(t).toContain('QUESTIONS TO ASK\n- How do you review code?');
    expect(t).toContain('- Kubernetes: GAP — not in the CV');
    expect(t).toContain('- Laravel: 7 years of Laravel');
  });
});
