// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VisaBadge } from '@/components/visa';

describe('VisaBadge', () => {
  it.each([
    ['offered', '✓ Visa/relocation offered', 'text-emerald-700'],
    ['not-needed', '✓ No visa needed', 'text-emerald-700'],
    ['can-sponsor', '? Company can sponsor, posting does not say', 'text-amber-700'],
    ['silent', '? Visa/relocation not mentioned', 'text-amber-700'],
  ] as const)('labels %s plainly, with the full note as its title', (visa_evidence, text, tone) => {
    render(<VisaBadge job={{ visa: 'UAE: the full note', visa_evidence }} />);
    const el = screen.getByText(text);
    expect(el).toHaveClass(tone);
    expect(el).toHaveAttribute('title', 'UAE: the full note');
  });

  it('shows the old note in grey for a job not re-scored yet, and nothing without one', () => {
    render(<VisaBadge job={{ visa: 'UAE: employer issues work visa', visa_evidence: null }} />);
    expect(screen.getByText('UAE: employer issues work visa')).toHaveClass('text-zinc-500');
    const { container } = render(<VisaBadge job={{ visa: null, visa_evidence: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
