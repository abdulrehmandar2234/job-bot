// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/page';
import JobPage from '@/app/jobs/[id]/page';
import { followUpCount } from '@/lib/db';
import { cleanupDb, closeDb, daysAgo, ensureSchema, insertJob } from '../helpers/db';

vi.mock('@/app/actions', () => ({
  fetchNow: vi.fn(),
  setStatus: vi.fn(),
  prepare: vi.fn(),
  aiReview: vi.fn(),
  saveNotes: vi.fn(),
  draftAnswers: vi.fn(),
  clearAnswers: vi.fn(),
  dismissTask: vi.fn(),
}));
// TaskWatcher (a client component) needs the app router; the page tests render outside Next.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<object>()), runBot: vi.fn() }));
vi.mock('@/app/jobs/[id]/open-actions', () => ({ checkStillOpen: vi.fn() }));
vi.mock('@/app/jobs/[id]/followup-actions', () => ({ draftFollowUp: vi.fn(), markFollowedUp: vi.fn() }));

// Same approach as page.test.tsx: await the async server components inside <Suspense> and render their output.
type AsyncEl = ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
async function resolve(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolve));
  if (!isValidElement(node)) return node;
  const props = node.props as { children?: ReactNode; fallback?: unknown };
  if (props.fallback !== undefined) {
    const child = props.children as AsyncEl;
    return <Fragment key={node.key}>{await child.type(child.props)}</Fragment>;
  }
  if (typeof node.type !== 'string' || props.children === undefined) return node;
  return cloneElement(node, undefined, await resolve(props.children));
}
const renderList = async (searchParams: Record<string, string> = {}) =>
  render(
    <>{await resolve(Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as Parameters<typeof Page>[0]))}</>,
  );
const renderJob = async (id: string) =>
  render(<>{await resolve(JobPage({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof JobPage>[0]))}</>);

const tab = (label: string) => within(screen.getByRole('navigation')).getByRole('link', { name: new RegExp(`^${label} \\d+$`) });
const cardTitles = () =>
  screen
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('a[href^="/jobs/"]')?.textContent ?? '')
    .filter((t) => t.startsWith('TG '));

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('follow-up reminders on the dashboard', () => {
  it('"Needs follow-up" sits after Applied with the due count, and lists only due jobs', async () => {
    const before = await followUpCount();
    await insertJob({ id: 'fu-due', title: 'TG waiting', status: 'applied', applied_at: daysAgo(9) });
    await insertJob({ id: 'fu-fresh', title: 'TG fresh', status: 'applied', applied_at: daysAgo(1) });
    await renderList({ view: 'followup' });
    expect(tab('Needs follow-up')).toHaveTextContent(`Needs follow-up ${before + 1}`);
    expect(tab('Needs follow-up')).toHaveAttribute('href', '/?view=followup');
    const labels = within(screen.getByRole('navigation'))
      .getAllByRole('link')
      .map((a) => a.textContent!.replace(/ \d+$/, ''));
    expect(labels.slice(1, 4)).toEqual(['Prepared', 'Applied', 'Needs follow-up']);
    expect(cardTitles()).toEqual(['TG waiting · Acme Follow up · 9 days']);
    // The filter form keeps the view instead of switching to a status.
    expect(tab('Needs follow-up')).toHaveAttribute('aria-current', 'page');
    expect(tab('Applied')).not.toHaveAttribute('aria-current');
    const filters = screen.getByRole('searchbox', { name: 'Search company or title' }).closest('form')!;
    expect((filters.querySelector('input[name="view"]') as HTMLInputElement).value).toBe('followup');
    expect(filters.querySelector('input[name="status"]')).toBeNull();
  });

  it('the Applied tab lists every applied job, with the badge on the due one', async () => {
    await insertJob({ id: 'fu-due', title: 'TG waiting', status: 'applied', applied_at: daysAgo(9) });
    await insertJob({ id: 'fu-fresh', title: 'TG fresh', status: 'applied', applied_at: daysAgo(1) });
    await renderList({ status: 'applied' });
    expect(cardTitles().sort()).toEqual(['TG fresh · Acme ', 'TG waiting · Acme Follow up · 9 days']);
  });

  it('says so when nothing is due', async () => {
    await insertJob({ id: 'fu-fresh', title: 'TG fresh', status: 'applied', applied_at: daysAgo(1) });
    await renderList({ view: 'followup' });
    expect(screen.getByText(/^No follow-ups due/)).toBeInTheDocument();
  });

  it('the job page shows the follow-up section with its draft', async () => {
    const id = await insertJob({
      id: 'fu-page',
      title: 'TG waiting',
      status: 'applied',
      applied_at: daysAgo(9),
      follow_up_draft: 'Dear Acme Hiring Team,\nStill keen.',
      follow_up_draft_at: new Date(),
    });
    await renderJob(id);
    const section = screen.getByRole('heading', { name: /^Follow-up/ }).closest('section')!;
    expect(within(section).getByText(/No news for 9 days/)).toBeInTheDocument();
    expect(within(section).getByText(/Still keen\./)).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'I sent a follow-up' })).toBeInTheDocument();
  });
});
