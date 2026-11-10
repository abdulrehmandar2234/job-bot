// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveApplicant, saveConfig, saveJson, type SaveState } from '@/app/settings/actions';
import { ApplicantForm, ConfigForm, JsonEditor } from '@/components/settings';
import type { SettingsFile } from '@/lib/settings';

// Leaving the Settings page with edits that were not saved asks first (the browser's own "Leave site?" dialog,
// through a beforeunload listener); once the edits are saved, leaving asks nothing.

vi.mock('@/app/settings/actions', () => ({ saveConfig: vi.fn(), saveApplicant: vi.fn(), saveJson: vi.fn() }));

const file = (data: object | null, extra: Partial<SettingsFile> = {}): SettingsFile => ({
  file: '/x/file.json',
  text: JSON.stringify(data),
  data: data as SettingsFile['data'],
  error: null,
  example: false,
  ...extra,
});
const CONFIG = { minScore: 45, companies: [{ name: 'Careem', ats: 'greenhouse', token: 'careem' }] };
const APPLICANT = { currentLocation: 'Lahore', other: { github: 'gh/me' } };
const saved: SaveState = { ok: true, message: 'Saved.', errors: [] };
const rejected: SaveState = { ok: false, message: 'Not saved: 1 problem.', errors: [{ path: 'minScore', message: 'Too low' }] };

/** Whether leaving the page now would ask first: a listener cancelled the beforeunload event. */
function leavingAsks() {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('unsaved changes on the Settings page', () => {
  it('warns on leaving after an edit, keeps warning after a rejected save, and stops once saved', async () => {
    vi.mocked(saveConfig).mockResolvedValueOnce(rejected).mockResolvedValueOnce(saved);
    const user = userEvent.setup();
    render(<ConfigForm config={file(CONFIG)} />);
    expect(leavingAsks()).toBe(false);

    await user.type(screen.getByLabelText('Minimum score'), '0');
    expect(leavingAsks()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save search settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved');
    expect(leavingAsks()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save search settings' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    // The listener goes in the effect after the save's render.
    await waitFor(() => expect(leavingAsks()).toBe(false));
  });

  it('counts adding or removing a row as an edit', async () => {
    const user = userEvent.setup();
    render(<ApplicantForm applicant={file(APPLICANT)} />);
    expect(leavingAsks()).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Remove other fact 1' }));
    expect(leavingAsks()).toBe(true);
  });

  it('counts a company row added, and removes the listener when the form goes away', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ConfigForm config={file(CONFIG)} />);
    await user.click(screen.getByRole('button', { name: '+ Add company' }));
    expect(leavingAsks()).toBe(true);
    // Unmounting the form (leaving the page in the app) removes its listener.
    unmount();
    expect(leavingAsks()).toBe(false);
  });

  it('warns for the JSON editor too, until it is saved', async () => {
    vi.mocked(saveJson).mockResolvedValue(saved);
    const user = userEvent.setup();
    render(<JsonEditor kind="config" file={file(CONFIG)} />);
    await user.click(screen.getByText('Advanced: edit JSON'));
    await user.type(screen.getByLabelText('config JSON'), ' ');
    expect(leavingAsks()).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save JSON' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
    // The listener goes in the effect after the save's render.
    await waitFor(() => expect(leavingAsks()).toBe(false));
    expect(saveApplicant).not.toHaveBeenCalled();
  });

  it('shows an unreadable file in a dark-mode aware alert', () => {
    render(<ConfigForm config={file(null, { error: 'bad JSON' })} />);
    expect(screen.getByRole('alert')).toHaveClass('text-rose-700', 'dark:text-rose-400');
  });
});
