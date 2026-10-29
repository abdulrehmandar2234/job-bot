// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoleExclude } from '@/app/settings/actions';
import { SkipButton } from '@/components/skip-button';
import { SkipPatterns } from '@/components/skip-patterns';
import type { SkipInsights } from '@/lib/skip-insights';

vi.mock('@/app/actions', () => ({ setStatus: vi.fn() }));
vi.mock('@/app/settings/actions', () => ({ addRoleExclude: vi.fn() }));

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe('SkipButton', () => {
  it('skips in one click, with an optional reason in the same form', () => {
    render(<SkipButton id="j1" />);
    const form = screen.getByRole('button', { name: 'Skip' }).closest('form')!;
    expect((form.querySelector('input[name="status"]') as HTMLInputElement).value).toBe('skipped');
    const select = within(form).getByLabelText('Skip reason (optional)');
    expect(select).toHaveValue('');
    expect(within(select).getAllByRole('option').map((o) => o.textContent))
      .toEqual(['why? (optional)', 'Stack', 'Seniority', 'Salary', 'Location / visa', 'Company', 'Language', 'Other']);
  });
});

const insights = (o: Partial<SkipInsights> = {}): SkipInsights => ({
  counts: [{ reason: 'seniority', n: 9 }, { reason: null, n: 2 }],
  words: [{ word: 'principal', skips: 9 }, { word: 'staff', skips: 1 }],
  suggestions: [{ word: 'principal', skips: 9, pattern: '\\bprincipal\\b' }],
  ...o,
});

describe('SkipPatterns', () => {
  it('shows counts per reason, skip-only words and suggestions with a link to settings', () => {
    render(<SkipPatterns insights={insights()} />);
    const counts = screen.getAllByRole('list')[0];
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Seniority9', 'No reason2']);
    expect(screen.getByText('principal', { selector: 'span' })).toHaveTextContent('principal 9');
    const s = screen.getByText('\\bprincipal\\b').closest('li')!;
    expect(s).toHaveTextContent('Add \\bprincipal\\b to roleExclude? (9 skips)');
    expect(within(s).getByRole('link', { name: 'Open settings' })).toHaveAttribute('href', '/settings');
  });

  it('explains empty states', () => {
    const { rerender } = render(<SkipPatterns insights={insights({ counts: [], words: [], suggestions: [] })} />);
    expect(screen.getByText(/No skipped jobs yet/)).toBeInTheDocument();
    rerender(<SkipPatterns insights={insights({ words: [], suggestions: [] })} />);
    expect(screen.getByText('None yet.')).toBeInTheDocument();
    expect(screen.getByText(/None: a word needs 3 skips/)).toBeInTheDocument();
  });

  it('changes nothing unless the user confirms', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const user = userEvent.setup();
    render(<SkipPatterns insights={insights()} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Add \\bprincipal\\b to roleExclude'));
    expect(addRoleExclude).not.toHaveBeenCalled();
  });

  it('applies the pattern after confirming and shows the result', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.mocked(addRoleExclude).mockResolvedValue({ ok: true, message: 'Saved. Re-scored 5 jobs.', errors: [] });
    const user = userEvent.setup();
    render(<SkipPatterns insights={insights()} />);
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved. Re-scored 5 jobs.');
    expect((vi.mocked(addRoleExclude).mock.calls[0][1] as FormData).get('pattern')).toBe('\\bprincipal\\b');
    expect(screen.queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });
});
