// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionForm } from '@/components/action-form';
import { Busy } from '@/components/tasks';
import type { TextFormState } from '@/lib/written-text';

// The one-click action form: a failed action answers the form (role=alert next to the button) and the page
// keeps its state, instead of the throw that would replace the whole page with app/error.tsx.

const action = vi.fn<(prev: TextFormState, fd: FormData) => Promise<TextFormState>>();
const lastForm = () => action.mock.calls.at(-1)![1];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ActionForm', () => {
  it('submits the hidden fields and the extra controls to the action', async () => {
    action.mockResolvedValue(null);
    const user = userEvent.setup();
    render(
      <ActionForm action={action} fields={{ id: 'job:1', status: 'skipped' }} label="Skip">
        <select name="reason" defaultValue="seniority" aria-label="why?">
          <option value="seniority">seniority</option>
        </select>
      </ActionForm>,
    );
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    const fd = lastForm();
    expect([fd.get('id'), fd.get('status'), fd.get('reason')]).toEqual(['job:1', 'skipped', 'seniority']);
  });

  it('shows nothing extra on success', async () => {
    action.mockResolvedValue(null);
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={{ id: 'job:1' }} label="Prepare CV" />);
    await user.click(screen.getByRole('button', { name: 'Prepare CV' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Prepare CV' })).toBeEnabled();
  });

  it('shows the error next to the button when the action answers with one, and the button stays usable', async () => {
    action.mockResolvedValue({ ok: false, message: 'Unknown job' });
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={{ id: 'job:gone' }} label="Mark applied ✓" />);
    await user.click(screen.getByRole('button', { name: 'Mark applied ✓' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Unknown job');
    // The page was not replaced: the button is still there and can be clicked again.
    expect(screen.getByRole('button', { name: 'Mark applied ✓' })).toBeEnabled();
  });

  it('shows the pending text while the action runs', async () => {
    let resolve!: (s: TextFormState) => void;
    action.mockImplementation(() => new Promise<TextFormState>((r) => (resolve = r)));
    const user = userEvent.setup();
    render(<ActionForm action={action} fields={{ id: 'job:1' }} pendingText="Starting…" label="AI review" />);
    await user.click(screen.getByRole('button', { name: 'AI review' }));
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled();
    resolve(null);
    expect(await screen.findByRole('button', { name: 'AI review' })).toBeEnabled();
  });

  it('renders `busy` in place of the submit button while a background task runs', () => {
    render(<ActionForm action={action} fields={{ id: 'job:1' }} label="Draft answers" busy={<Busy>Drafting answers…</Busy>} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Drafting answers…');
  });

  it('keeps what the user chose in the extra controls when the action fails', async () => {
    action.mockResolvedValue({ ok: false, message: 'The database is not reachable right now. Try again in a moment.' });
    const user = userEvent.setup();
    render(
      <ActionForm action={action} fields={{ id: 'job:1' }} label="Save notes">
        <textarea name="notes" defaultValue="" aria-label="Job notes" />
      </ActionForm>,
    );
    await user.type(screen.getByLabelText('Job notes'), 'Recruiter: Sam');
    await user.click(screen.getByRole('button', { name: 'Save notes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not reachable');
    expect(screen.getByLabelText('Job notes')).toHaveValue('Recruiter: Sam');
  });
});
