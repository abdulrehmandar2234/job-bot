// @vitest-environment jsdom
import { act, render, screen, within } from '@testing-library/react';
import { useRouter } from 'next/navigation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskWatcher } from '@/components/client';
import { JobActions } from '@/components/job-actions';
import { TaskBar } from '@/components/tasks';
import type { Job } from '@/lib/db';
import type { TaskView } from '@/lib/tasks';

vi.mock('@/app/actions', () => ({
  writeLetter: vi.fn(),
  setStatus: vi.fn(),
  prepare: vi.fn(),
  aiReview: vi.fn(),
  dismissTask: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));

const refresh = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;
/** Each poll answers with the next list of active ids (the last one repeats). */
const answers = (...lists: number[][]) => {
  let i = 0;
  fetchMock.mockImplementation(async () => Response.json({ active: lists[Math.min(i++, lists.length - 1)] }));
};
const tick = (ms = 3000) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  vi.mocked(useRouter).mockReturnValue({ refresh } as unknown as ReturnType<typeof useRouter>);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TaskWatcher', () => {
  it('does not poll when nothing is active', async () => {
    render(<TaskWatcher active={[]} />);
    await tick(30_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('polls while the task runs, then refreshes once and stops when it finishes', async () => {
    answers([7], [7], []);
    render(<TaskWatcher active={[7]} />);
    await tick();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refresh).not.toHaveBeenCalled();
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
    await tick(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('asks only about one job when given, and polls at the given interval', async () => {
    answers([3]);
    render(<TaskWatcher active={[3]} job="greenhouse:a b" intervalMs={1000} />);
    await tick(1000);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/tasks?job=greenhouse%3Aa%20b', { cache: 'no-store' });
  });

  it('refreshes when another task starts too', async () => {
    answers([1, 2]);
    render(<TaskWatcher active={[1]} />);
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('starts polling again when the refreshed page renders new active tasks', async () => {
    answers([]);
    const { rerender } = render(<TaskWatcher active={[1]} />);
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
    answers([2], []);
    rerender(<TaskWatcher active={[2]} />);
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
    await tick();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps polling through a failed request', async () => {
    answers([]);
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    render(<TaskWatcher active={[1]} />);
    await tick();
    expect(refresh).not.toHaveBeenCalled();
    await tick();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('stops polling when unmounted', async () => {
    answers([1]);
    const { unmount } = render(<TaskWatcher active={[1]} />);
    await tick();
    unmount();
    await tick(30_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

const view = (over: Partial<TaskView>): TaskView => ({
  id: 1,
  kind: 'fetch',
  job_id: null,
  status: 'running',
  error: null,
  created_at: new Date(),
  started_at: new Date(),
  finished_at: null,
  company: null,
  title: null,
  ...over,
});

describe('TaskBar', () => {
  it('shows nothing when there are no tasks', () => {
    render(<TaskBar tasks={[]} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says what is running, with the job on the dashboard', () => {
    render(
      <TaskBar tasks={[view({}), view({ id: 2, kind: 'prepare', job_id: 'j', status: 'queued', company: 'Acme', title: 'Engineer' })]} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Working… Fetching new jobs · Preparing CV (Acme — Engineer)');
  });

  it('leaves out the job on its own page', () => {
    render(<TaskBar job="j" tasks={[view({ kind: 'answers', job_id: 'j', company: 'Acme', title: 'Engineer' })]} />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Working… Drafting answers$/);
  });

  it('shows each failure with its error and a dismiss button for that task', () => {
    render(
      <TaskBar
        tasks={[view({ id: 9, kind: 'ai_review', status: 'failed', error: 'Claude is offline', company: 'Acme', title: 'Engineer' })]}
      />,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('AI reviewing (Acme — Engineer) failed');
    expect(alert).toHaveTextContent('Claude is offline');
    const form = within(alert).getByRole('button', { name: 'Dismiss' }).closest('form')!;
    expect(form.querySelector('input[name="task"]')).toHaveValue('9');
  });

  it('shows only the most recently finished task, with a Dismiss for exactly that task', () => {
    render(
      <TaskBar
        tasks={[
          view({ id: 5, kind: 'letter', status: 'done', finished_at: new Date('2026-01-01T10:00:00Z') }),
          view({
            id: 6,
            kind: 'summary',
            status: 'done',
            finished_at: new Date('2026-01-01T11:00:00Z'),
            company: 'Acme',
            title: 'Engineer',
          }),
        ]}
      />,
    );
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Writing CV summary (Acme — Engineer) finished');
    expect(notice).not.toHaveTextContent('Writing cover letter');
    const form = within(notice).getByRole('button', { name: 'Dismiss' }).closest('form')!;
    expect(form.querySelector('input[name="task"]')).toHaveValue('6');
  });

  it('shows no finished notice once the task is dismissed (it is no longer in the list)', () => {
    render(<TaskBar tasks={[view({ kind: 'prepare', job_id: 'j', company: 'Acme', title: 'Engineer' })]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Working…');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument();
  });

  it('polls only for active tasks', async () => {
    answers([]);
    render(<TaskBar tasks={[view({ id: 4, status: 'failed', error: 'x' })]} />);
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('JobActions while a task runs', () => {
  const job = { id: 'j', url: 'https://example.com/j', status: 'new', cv_version: null, ai_score: null } as Job;
  const buttons = () => screen.queryAllByRole('button').map((b) => b.textContent);

  it('shows progress in place of the prepare and AI review buttons', () => {
    render(<JobActions job={job} busy={['prepare', 'ai_review']} />);
    expect(buttons()).toEqual(['Mark applied ✓', 'Skip']);
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toEqual(['Preparing CV…', 'AI reviewing…']);
  });

  it('shows progress even when a CV exists (rewriting)', () => {
    render(<JobActions job={{ ...job, cv_version: 'default', ai_score: 80 }} busy={['prepare']} />);
    expect(screen.queryByRole('link', { name: /CV \(/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Preparing CV…');
  });
});
