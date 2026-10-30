// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Collapsible, FoldedText } from '@/components/collapsible';

describe('Collapsible', () => {
  it('is a closed <details> whose summary holds the heading and the visible hint', () => {
    render(
      <Collapsible id="history" title="History · 2 changes" hint="Last: applied">
        <p>new → applied</p>
      </Collapsible>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'History · 2 changes' });
    const summary = heading.closest('summary')!;
    expect(summary).toHaveTextContent('Last: applied');
    expect(summary).not.toHaveTextContent('new → applied');
    const details = summary.closest('details')!;
    expect(details).toHaveAttribute('id', 'history');
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('new → applied');
  });

  it('can start open', () => {
    render(
      <Collapsible title="Notes" open>
        x
      </Collapsible>,
    );
    expect(screen.getByRole('heading', { name: 'Notes' }).closest('details')).toHaveAttribute('open');
  });
});

describe('FoldedText', () => {
  it('shows a clamped preview and folds the full content behind "Show full <label>"', () => {
    render(
      <FoldedText preview={'Line one\nLine two'} label="letter">
        <button type="button">Edit</button>
      </FoldedText>,
    );
    const details = screen.getByText('Show full letter').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toContainElement(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('Hide full letter').closest('summary')).toBe(details.querySelector('summary'));
    const preview = screen.getByText(/Line one/);
    expect(preview).toHaveClass('line-clamp-4', 'peer-open:hidden');
    expect(details).not.toContainElement(preview);
    expect(details).toHaveClass('peer');
  });
});
