// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/page';
import JobPage from '@/app/jobs/[id]/page';
import { statusCounts } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../helpers/db';

vi.mock('@/app/actions', () => ({
  fetchNow: vi.fn(), setStatus: vi.fn(), prepare: vi.fn(), aiReview: vi.fn(), saveNotes: vi.fn(), draftAnswers: vi.fn(), clearAnswers: vi.fn(),
}));
vi.mock('@/app/jobs/[id]/open-actions', () => ({ checkStillOpen: vi.fn() }));

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
  render(<>{await resolve(Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as Parameters<typeof Page>[0]))}</>);
const renderJob = async (id: string) =>
  render(<>{await resolve(JobPage({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof JobPage>[0]))}</>);

const tab = (label: string) => within(screen.getByRole('navigation')).getByRole('link', { name: new RegExp(`^${label} \\d+$`) });
const cardTitles = () => screen.queryAllByRole('listitem').map((li) => li.querySelector('a[href^="/jobs/"]')?.textContent ?? '')
  .filter((t) => t.startsWith('TG '));

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('expired postings on the dashboard', () => {
  it('have their own tab with a count, and are not in Matching', async () => {
    const before = await statusCounts();
    await insertJob({ id: 'exp-1', title: 'TG closed one', status: 'expired', closed_at: new Date() });
    await insertJob({ id: 'exp-2', title: 'TG open one', status: 'new' });
    await renderList({ status: 'expired' });
    expect(tab('Expired')).toHaveTextContent(`Expired ${(before.expired ?? 0) + 1}`);
    expect(tab('Expired')).toHaveAttribute('href', '/?status=expired');
    // Tab order: Skipped, Expired, Filtered out.
    const labels = within(screen.getByRole('navigation')).getAllByRole('link').map((a) => a.textContent!.replace(/ \d+$/, ''));
    expect(labels.slice(-3)).toEqual(['Skipped', 'Expired', 'Filtered out']);
    expect(cardTitles()).toEqual(['TG closed one · Acme Expired']);
  });

  it('the Matching tab does not list expired jobs', async () => {
    await insertJob({ id: 'exp-1', title: 'TG closed one', status: 'expired' });
    await insertJob({ id: 'exp-2', title: 'TG open one', status: 'new' });
    await renderList();
    expect(cardTitles()).toEqual(['TG open one · Acme ']);
  });

  it('the job page shows the badge and the "Check if still open" button', async () => {
    const id = await insertJob({ id: 'exp-page', title: 'TG closed one', status: 'expired', closed_at: new Date(),
      checked_open_at: new Date() });
    await renderJob(id);
    expect(within(screen.getByRole('heading', { level: 1 })).getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText(/Status:/)).toHaveTextContent('Status: Expired');
    const button = screen.getByRole('button', { name: 'Check if still open' });
    expect((button.closest('form')!.querySelector('input[name="id"]') as HTMLInputElement).value).toBe(PREFIX + 'exp-page');
    expect(screen.getByText(/Posting last checked/)).toBeInTheDocument();
  });
});
