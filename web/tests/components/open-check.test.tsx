// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { checkStillOpen } from '@/app/jobs/[id]/open-actions';
import { ExpiredBadge, OpenCheck } from '@/components/open-check';

// The action is only referenced as a form action here; it is tested in tests/app/jobs/open-actions.test.ts.
vi.mock('@/app/jobs/[id]/open-actions', () => ({ checkStillOpen: vi.fn() }));

describe('ExpiredBadge', () => {
  it('shows "Expired" for an expired job', () => {
    render(<ExpiredBadge job={{ status: 'expired', closed_at: new Date('2026-10-20') }} />);
    expect(screen.getByText('Expired')).toHaveAttribute('title', 'Posting found closed on 20 Oct');
  });

  it('shows "Posting closed" on a job you applied to (its status is kept)', () => {
    render(<ExpiredBadge job={{ status: 'applied', closed_at: new Date('2026-10-20') }} />);
    expect(screen.getByText('Posting closed')).toBeInTheDocument();
  });

  it('shows nothing for an open posting', () => {
    const { container } = render(<ExpiredBadge job={{ status: 'new', closed_at: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('OpenCheck', () => {
  it('posts the job id to checkStillOpen and says when the posting was last checked', () => {
    render(<OpenCheck job={{ id: 'greenhouse:acme:1', checked_open_at: new Date(Date.now() - 2 * 3_600_000) }} />);
    const button = screen.getByRole('button', { name: 'Check if still open' });
    const formEl = button.closest('form')!;
    expect((formEl.querySelector('input[name="id"]') as HTMLInputElement).value).toBe('greenhouse:acme:1');
    expect(checkStillOpen).toBeDefined();
    expect(screen.getByText('Posting last checked 2h ago')).toBeInTheDocument();
  });

  it('says when the posting was never checked', () => {
    render(<OpenCheck job={{ id: 'x' }} />);
    expect(screen.getByText('Posting not checked yet')).toBeInTheDocument();
  });
});
