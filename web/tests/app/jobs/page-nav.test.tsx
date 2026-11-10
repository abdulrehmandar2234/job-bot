// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import NotFound from '@/app/not-found';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, dateDaysAgo, ensureSchema, insertJob } from '../../helpers/db';

vi.mock('@/app/actions', () => ({
  writeLetter: vi.fn(),
  rewriteLetter: vi.fn(),
  saveLetter: vi.fn(),
  writeSummary: vi.fn(),
  writeHeadline: vi.fn(),
  rewriteHeadline: vi.fn(),
  saveHeadline: vi.fn(),
  rewriteSummary: vi.fn(),
  saveSummary: vi.fn(),
  tailorCv: vi.fn(),
  applyCvTemplate: vi.fn(),
  improveCv: vi.fn(),
  addSkillsToCv: vi.fn(),
  reviewCv: vi.fn(),
  setStatus: vi.fn(),
  prepare: vi.fn(),
  aiReview: vi.fn(),
  saveNotes: vi.fn(),
  draftAnswers: vi.fn(),
  clearAnswers: vi.fn(),
  dismissTask: vi.fn(),
  undoStatus: vi.fn(),
}));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<object>()), runBot: vi.fn(async () => 'Not found') }));

// The job page's way back to the list it was opened from (`?from=`), and Previous / Next within that list.

async function renderJob(id: string, from?: string) {
  const shell = Page({
    params: Promise.resolve({ id: encodeURIComponent(id) }),
    searchParams: Promise.resolve(from === undefined ? {} : { from }),
  } as Parameters<typeof Page>[0]) as ReactElement<{ children: ReactNode }>;
  const suspense = ([] as ReactNode[])
    .concat(shell.props.children)
    .find(
      (c): c is ReactElement<{ children: ReactElement }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined,
    )!;
  const detail = suspense.props.children as ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
  return render(<>{await detail.type(detail.props)}</>);
}

const nav = () => within(screen.getByRole('navigation', { name: 'Job list' }));
const href = (id: string, from: string) => `/jobs/${encodeURIComponent(id)}?${new URLSearchParams({ from })}`;

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('job page navigation', () => {
  const recent = new Date(Date.now() - 3_600_000);
  let top: string;
  let mid: string;
  let low: string;
  let weak: string;
  beforeEach(async () => {
    top = await insertJob({ id: 'nav-top', title: 'TG navzz top', status: 'new', score: 90, posted_at: recent });
    mid = await insertJob({ id: 'nav-mid', title: 'TG navzz mid', status: 'new', score: 80, posted_at: recent });
    low = await insertJob({ id: 'nav-low', title: 'TG navzz low', status: 'new', score: 70, posted_at: recent });
    weak = await insertJob({ id: 'nav-weak', title: 'TG navzz weak', status: 'new', score: 40, posted_at: recent });
    await insertJob({ id: 'nav-old', title: 'TG navzz old', status: 'new', score: 75, posted_at: dateDaysAgo(5) });
    await insertJob({ id: 'nav-applied', title: 'TG navzz applied', status: 'applied', score: 85, posted_at: recent });
  });

  it('"← All jobs" goes back to the exact list, and Previous / Next walk it with its filters', async () => {
    const from = '/?status=new&min=60&q=navzz&in=tab&days=1&page=2';
    await renderJob(mid, from);
    expect(nav().getByRole('link', { name: '← All jobs' })).toHaveAttribute('href', from);
    // Score order, without the job under the minimum score, the one posted 5 days ago or the applied one.
    expect(nav().getByRole('link', { name: '← Previous' })).toHaveAttribute('href', href(top, from));
    expect(nav().getByRole('link', { name: 'Next →' })).toHaveAttribute('href', href(low, from));
  });

  it('ends at the last job the filters leave, and goes further without them', async () => {
    await renderJob(low, '/?status=new&min=60&q=navzz&in=tab&days=1');
    expect(nav().queryByRole('link', { name: 'Next →' })).toBeNull();
    expect(nav().getByText('Next →')).toBeInTheDocument(); // shown, but not a link

    document.body.innerHTML = '';
    await renderJob(low, '/?status=new&q=navzz&in=tab&days=1');
    const from = '/?status=new&q=navzz&in=tab&days=1';
    expect(nav().getByRole('link', { name: 'Next →' })).toHaveAttribute('href', href(weak, from));
  });

  it('keeps Previous / Next after the job is marked applied and leaves the list it came from', async () => {
    const from = '/?status=new&min=60&q=navzz&in=tab&days=1';
    // What the dashboard's setStatus does: the status, applied_at, and the event.
    await pool.query(`UPDATE jobs SET status = 'applied', applied_at = now() WHERE id = $1`, [mid]);
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status) VALUES ($1, 'new', 'applied')`, [mid]);
    await renderJob(mid, from);
    expect(nav().getByRole('link', { name: '← Previous' })).toHaveAttribute('href', href(top, from));
    expect(nav().getByRole('link', { name: 'Next →' })).toHaveAttribute('href', href(low, from));
  });

  it('places a job that was never in the list by the list order', async () => {
    // The applied tab holds only nav-applied; mid sorts after it (coalesce(applied_at, first_seen_at), newest first).
    const from = '/?status=applied&q=navzz&in=tab&days=1';
    await renderJob(mid, from);
    expect(nav().getByRole('link', { name: '← All jobs' })).toHaveAttribute('href', from);
    expect(nav().getByRole('link', { name: '← Previous' })).toHaveAttribute('href', href('webtest:nav-applied', from));
    expect(nav().queryByRole('link', { name: 'Next →' })).toBeNull();
  });

  it('never follows a `from` that leaves the job list: back is the bare list, with no Previous / Next', async () => {
    for (const from of [
      'https://evil.example/?status=new',
      '//evil.example/',
      '/\\evil.example',
      '/settings?status=new',
      'javascript:alert(1)',
    ]) {
      const view = await renderJob(mid, from);
      expect(nav().getByRole('link', { name: '← All jobs' }), from).toHaveAttribute('href', '/');
      expect(nav().queryByText('← Previous'), from).toBeNull();
      view.unmount();
    }
    await renderJob(mid);
    expect(nav().getByRole('link', { name: '← All jobs' })).toHaveAttribute('href', '/');
  });

  it('lists the job page keys', async () => {
    await renderJob(mid, '/?status=new&q=navzz&in=tab&days=1');
    expect(screen.getByText(/j \/ k next \/ previous job · a mark applied · s skip · Esc back to the list/)).toBeInTheDocument();
  });
});

describe('not-found page', () => {
  it('explains and links back to the job list', () => {
    render(<NotFound />);
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← Back to the job list' })).toHaveAttribute('href', '/');
  });
});
