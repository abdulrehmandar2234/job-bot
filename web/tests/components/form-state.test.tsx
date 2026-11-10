// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Problem } from '@/components/form-state';

// The answer of a form's action next to its button: failures as an alert, a success's message as a status line.

describe('Problem', () => {
  it('shows nothing before the first answer', () => {
    const { container } = render(<Problem state={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a failure as an alert, dark-mode aware', () => {
    render(<Problem state={{ ok: false, message: 'Unknown job' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown job');
    expect(screen.getByRole('alert')).toHaveClass('text-rose-700', 'dark:text-rose-400');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it("shows a success's message as a small muted-green status line", () => {
    render(<Problem state={{ ok: true, message: 'Skipped 3 jobs' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Skipped 3 jobs');
    expect(screen.getByRole('status')).toHaveClass('text-sm', 'text-emerald-700', 'dark:text-emerald-400');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows nothing for a success without a message', () => {
    const { container } = render(<Problem state={{ ok: true, message: '' }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
