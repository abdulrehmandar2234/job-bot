// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorPage from '@/app/error';
import JobError from '@/app/jobs/[id]/error';
import { errorText } from '@/components/error-panel';

// The boundaries log the error for the dev console; keep the test output clean.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

const serverError = () => Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '12345' });

describe('app/error.tsx', () => {
  it('shows the message and a working "Try again", and keeps the header links', () => {
    const retry = vi.fn();
    render(<ErrorPage error={new Error('Could not start fetching new jobs')} retry={retry} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not start fetching new jobs');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();

    expect(screen.getByRole('heading', { level: 1, name: 'Job Bot' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All jobs' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/analytics');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(console.error).toHaveBeenCalledWith(expect.any(Error));
  });

  it('shows the digest of a Server Component error, which hides its message in production', () => {
    render(<ErrorPage error={serverError()} retry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Error id: 12345');
  });
});

describe('app/jobs/[id]/error.tsx', () => {
  it('keeps the back link to the job list next to the error and "Try again"', () => {
    const retry = vi.fn();
    render(<JobError error={new Error('Job not prepared')} retry={retry} />);

    expect(screen.getByRole('link', { name: '← All jobs' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('alert')).toHaveTextContent('Job not prepared');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('errorText', () => {
  it('reads Errors, digests and thrown non-Error values', () => {
    expect(errorText(new Error('boom'))).toEqual({ message: 'boom' });
    expect(errorText(serverError())).toEqual({ message: 'An error occurred in the Server Components render.', digest: '12345' });
    expect(errorText(new Error(''))).toEqual({ message: 'Unknown error' });
    expect(errorText('plain string')).toEqual({ message: 'plain string' });
  });
});
