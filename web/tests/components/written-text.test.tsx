// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WrittenText } from '@/components/written-text';
import type { TextFormState } from '@/lib/written-text';

const save = vi.fn<(prev: TextFormState, fd: FormData) => Promise<TextFormState>>();
const rewrite = vi.fn<(prev: TextFormState, fd: FormData) => Promise<TextFormState>>();
const lastForm = (fn: typeof save) => fn.mock.calls.at(-1)![1];

const renderLetter = (busy = false) =>
  render(<WrittenText id="job:1" kind="letter" text={'Dear Acme,\nAI letter\n'} busy={busy} save={save} rewrite={rewrite} />);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WrittenText', () => {
  it('shows the text with Edit and "What should change?", and neither while the bot rewrites it', () => {
    const { rerender } = renderLetter();
    expect(screen.getByText(/AI letter/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByLabelText(/What should change\?/)).toHaveAttribute('maxlength', '1000');
    rerender(<WrittenText id="job:1" kind="letter" text="Dear Acme" busy save={save} rewrite={rewrite} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rewrite with feedback' })).toBeNull();
    expect(screen.getByText('Dear Acme')).toBeInTheDocument();
  });

  it('Edit opens the letter in a textarea; Save sends it with the job id and closes on success', async () => {
    save.mockResolvedValue({ ok: true, message: 'Saved.' });
    const user = userEvent.setup();
    renderLetter();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit cover letter');
    expect(box).toHaveValue('Dear Acme,\nAI letter\n');
    expect(box).toHaveAttribute('maxlength', '10000');
    await user.clear(box);
    await user.type(box, 'My own letter');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Edit cover letter')).toBeNull());
    const fd = lastForm(save);
    expect([fd.get('id'), fd.get('text')]).toEqual(['job:1', 'My own letter']);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it('keeps the typed text and shows the error when saving is refused', async () => {
    save.mockResolvedValue({ ok: false, message: 'The letter is being rewritten right now. Save again when it is done.' });
    const user = userEvent.setup();
    renderLetter();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Edit cover letter');
    await user.clear(box);
    await user.type(box, 'Text I do not want to lose');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('being rewritten right now');
    expect(screen.getByLabelText('Edit cover letter')).toHaveValue('Text I do not want to lose');
  });

  it('Cancel closes the editor without saving', async () => {
    const user = userEvent.setup();
    renderLetter();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Edit cover letter')).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it('sends the feedback with the job id, and keeps it with the error when it is refused', async () => {
    rewrite.mockResolvedValue({ ok: false, message: 'Feedback is too long: at most 1000 characters.' });
    const user = userEvent.setup();
    render(<WrittenText id="job:2" kind="summary" text="Senior engineer." busy={false} save={save} rewrite={rewrite} />);
    await user.type(screen.getByLabelText(/What should change\?/), 'shorter');
    await user.click(screen.getByRole('button', { name: 'Rewrite with feedback' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Feedback is too long');
    expect(screen.getByLabelText(/What should change\?/)).toHaveValue('shorter');
    const fd = lastForm(rewrite);
    expect([fd.get('id'), fd.get('feedback')]).toEqual(['job:2', 'shorter']);
  });

  it('edits the summary in a smaller box', async () => {
    const user = userEvent.setup();
    render(<WrittenText id="job:2" kind="summary" text="Senior engineer." busy={false} save={save} rewrite={rewrite} />);
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Edit CV summary')).toHaveAttribute('maxlength', '2000');
  });
});
