// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useFormStatus } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaytBookmarklet, CopyButton, SubmitButton } from '@/components/client';

vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  useFormStatus: vi.fn(),
}));

const formStatus = vi.mocked(useFormStatus);
const idle = { pending: false, data: null, method: null, action: null } as ReturnType<typeof useFormStatus>;
const busy = { pending: true, data: new FormData(), method: 'post', action: () => {} } as unknown as ReturnType<typeof useFormStatus>;

describe('BaytBookmarklet', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });
  afterEach(() => {
    alertSpy.mockRestore();
  });

  const bookmarkletCode = () => {
    const href = screen.getByText('⇱ Bayt → Job Bot').getAttribute('href')!;
    expect(href.startsWith('javascript:')).toBe(true);
    return href.slice('javascript:'.length);
  };

  /** Runs the bookmarklet as a browser would on a page with the given hostname. */
  const runOn = (hostname: string) => {
    const alert = vi.fn();
    const appended: HTMLScriptElement[] = [];
    const fakeDocument = {
      createElement: (tag: string) => document.createElement(tag),
      body: { appendChild: (el: HTMLScriptElement) => appended.push(el) },
    };
    new Function('location', 'alert', 'document', bookmarkletCode())({ hostname }, alert, fakeDocument);
    return { alert, appended };
  };

  it('sets a javascript: href after mount', () => {
    render(<BaytBookmarklet />);
    expect(bookmarkletCode()).toContain('bayt\\.com');
  });

  it('shows how to use it when clicked instead of navigating', async () => {
    render(<BaytBookmarklet />);
    await userEvent.click(screen.getByText('⇱ Bayt → Job Bot'));
    expect(alertSpy).toHaveBeenCalledWith('Drag this button to your bookmarks bar, then click it on bayt.com.');
  });

  it.each(['www.bayt.com', 'bayt.com'])('loads the collector script on %s', (host) => {
    render(<BaytBookmarklet />);
    const { alert, appended } = runOn(host);
    expect(alert).not.toHaveBeenCalled();
    expect(appended).toHaveLength(1);
    expect(appended[0].tagName).toBe('SCRIPT');
    expect(appended[0].src).toMatch(/^http:\/\/localhost:3100\/api\/bayt-script\?\d+$/);
  });

  it.each(['example.com', 'notbayt.com', 'bayt.com.evil.io'])('refuses to run on %s', (host) => {
    render(<BaytBookmarklet />);
    const { alert, appended } = runOn(host);
    expect(alert).toHaveBeenCalledWith('Open bayt.com first, then click this bookmark.');
    expect(appended).toHaveLength(0);
  });
});

describe('SubmitButton', () => {
  it('renders an enabled submit button while idle', () => {
    formStatus.mockReturnValue(idle);
    render(
      <SubmitButton pendingText="Saving…" className="btn-good">
        Save
      </SubmitButton>,
    );
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn).toHaveAttribute('type', 'submit');
    expect(btn).toBeEnabled();
    expect(btn).toHaveClass('btn', 'btn-good');
    expect(btn).not.toHaveClass('cursor-wait');
  });

  it('shows the pending text and disables itself while the form submits', () => {
    formStatus.mockReturnValue(busy);
    render(<SubmitButton pendingText="Saving…">Save</SubmitButton>);
    const btn = screen.getByRole('button', { name: 'Saving…' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveClass('opacity-60', 'cursor-wait');
  });

  it('falls back to an ellipsis without pending text', () => {
    formStatus.mockReturnValue(busy);
    render(<SubmitButton>Save</SubmitButton>);
    expect(screen.getByRole('button')).toHaveTextContent('…');
  });
});

describe('CopyButton', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('copies the text and confirms for 1.5s', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    render(<CopyButton text="Hello recruiter" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith('Hello recruiter');
    expect(screen.getByRole('button')).toHaveTextContent('Copied ✓');

    act(() => {
      vi.advanceTimersByTime(1499);
    });
    expect(screen.getByRole('button')).toHaveTextContent('Copied ✓');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('button')).toHaveTextContent('Copy');
  });

  it('says the copy failed, then resets, when the clipboard refuses the write', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('Document is not focused', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.useFakeTimers();
    render(<CopyButton text="Hello recruiter" />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith('Hello recruiter');
    expect(screen.getByRole('button')).toHaveTextContent('Copy failed');

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole('button')).toHaveTextContent('Copy');
  });

  it('says the copy failed when there is no clipboard API (plain http, old browser)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<CopyButton text="x" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(screen.getByRole('button')).toHaveTextContent('Copy failed');
  });

  it('uses a custom label', () => {
    render(<CopyButton text="x" label="Copy answer" />);
    expect(screen.getByRole('button', { name: 'Copy answer' })).toHaveAttribute('type', 'button');
  });
});
