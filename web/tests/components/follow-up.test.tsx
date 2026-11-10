// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FollowUp, FollowUpActions, FollowUpBadge } from '@/components/follow-up';
import type { Job } from '@/lib/db';

// The actions are only referenced as form actions here; they are tested in tests/app/jobs/followup-actions.test.ts.
vi.mock('@/app/jobs/[id]/followup-actions', () => ({ draftFollowUp: vi.fn(), markFollowedUp: vi.fn() }));

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000 - 60_000);
const job = (over: Partial<Job> = {}) =>
  ({
    id: 'greenhouse:acme:1',
    company: 'Acme',
    title: 'Engineer',
    status: 'applied',
    applied_at: daysAgo(9),
    follow_ups: 0,
    followed_up_at: null,
    follow_up_draft: null,
    follow_up_draft_at: null,
    ...over,
  }) as Job;
const button = (name: string) => screen.queryByRole('button', { name });
const formId = (name: string) => (button(name)!.closest('form')!.querySelector('input[name="id"]') as HTMLInputElement).value;

describe('FollowUpBadge', () => {
  it('shows how long an applied job has waited once it is due', () => {
    render(<FollowUpBadge job={job()} />);
    expect(screen.getByText('Follow up · 9 days')).toHaveAttribute('title', 'No news for 9 days: time to send a short follow-up');
  });

  it('shows nothing before 7 days, after the last follow-up, or for other statuses', () => {
    for (const j of [job({ applied_at: daysAgo(3) }), job({ follow_ups: 2, followed_up_at: daysAgo(30) }), job({ status: 'interview' })]) {
      const { container, unmount } = render(<FollowUpBadge job={j} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});

describe('FollowUp', () => {
  it('a due job: says so, offers a draft and "I sent a follow-up" for this job', () => {
    render(<FollowUp job={job()} />);
    expect(screen.getByRole('heading', { name: /Follow-up · 0 of 2 sent/ })).toBeInTheDocument();
    expect(screen.getByText('No news for 9 days: a short follow-up to the recruiter is worth sending.')).toBeInTheDocument();
    expect(formId('Draft follow-up')).toBe('greenhouse:acme:1');
    expect(formId('I sent a follow-up')).toBe('greenhouse:acme:1');
  });

  it('not due yet: says when the reminder comes', () => {
    render(<FollowUp job={job({ applied_at: daysAgo(2) })} />);
    expect(screen.getByText('Reminder after 7 days with no news (2 so far).')).toBeInTheDocument();
  });

  it('shows the draft to copy and "Redraft"', () => {
    render(<FollowUp job={job({ follow_up_draft: 'Dear Rita,\nStill keen.', follow_up_draft_at: new Date('2026-10-20') })} />);
    expect(screen.getByText(/Dear Rita,/)).toHaveTextContent('Dear Rita, Still keen.');
    expect(screen.getByText(/Draft · 20 Oct · review it, then send it yourself/)).toBeInTheDocument();
    expect(button('Copy')).toBeInTheDocument();
    expect(button('Redraft')).toBeInTheDocument();
  });

  it('after the last follow-up: no more reminders and no "I sent" button', () => {
    render(<FollowUp job={job({ follow_ups: 2, followed_up_at: new Date('2026-10-01') })} />);
    expect(screen.getByRole('heading', { name: /2 of 2 sent, last 1 Oct/ })).toBeInTheDocument();
    expect(screen.getByText('You have followed up 2 times; no more reminders for this job.')).toBeInTheDocument();
    expect(button('I sent a follow-up')).not.toBeInTheDocument();
  });

  it('shows "Drafting follow-up…" while the task runs', () => {
    render(<FollowUp job={job()} busy={['follow_up']} />);
    expect(screen.getByRole('status')).toHaveTextContent('Drafting follow-up…');
    expect(button('Draft follow-up')).not.toBeInTheDocument();
  });

  it('hidden for jobs that are not applied; a later status keeps only the old draft, without buttons', () => {
    const { container } = render(<FollowUp job={job({ status: 'new', applied_at: null })} />);
    expect(container).toBeEmptyDOMElement();
    render(<FollowUp job={job({ status: 'interview', follow_up_draft: 'Dear Acme Hiring Team,' })} />);
    expect(screen.getByText('Dear Acme Hiring Team,')).toBeInTheDocument();
    expect(button('Redraft')).not.toBeInTheDocument();
    expect(screen.queryByText(/Reminder after/)).not.toBeInTheDocument();
  });
});

describe('FollowUpActions (the "Needs follow-up" cards)', () => {
  it('drafts, copies the draft and records "I sent a follow-up" for this job, in one row', () => {
    render(<FollowUpActions job={job({ follow_up_draft: 'Dear Acme,\nStill keen.' })} />);
    expect(formId('Redraft')).toBe('greenhouse:acme:1');
    expect(button('Copy draft')).toBeInTheDocument();
    expect(formId('I sent a follow-up')).toBe('greenhouse:acme:1');
  });

  it('offers a first draft without a copy button, shows the running draft, and stops after the last follow-up', () => {
    const { unmount } = render(<FollowUpActions job={job()} busy={['follow_up']} />);
    expect(screen.getByText('Drafting follow-up…')).toBeInTheDocument();
    expect(button('Copy draft')).toBeNull();
    unmount();
    render(<FollowUpActions job={job({ follow_ups: 2 })} />);
    expect(button('Draft follow-up')).toBeInTheDocument();
    expect(button('I sent a follow-up')).toBeNull();
  });

  it('shows nothing for a job that is not applied', () => {
    const { container } = render(<FollowUpActions job={job({ status: 'interview' })} />);
    expect(container).toBeEmptyDOMElement();
  });
});
