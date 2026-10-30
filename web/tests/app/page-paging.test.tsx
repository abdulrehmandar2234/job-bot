// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/page';
import { cleanupDb, closeDb, ensureSchema, insertJob } from '../helpers/db';

vi.mock('@/app/actions', () => ({
  writeLetter: vi.fn(),
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
// The header and first-run banner read config.json per request (connection()); these tests render outside Next.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: async () => {},
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

const cardTitles = () =>
  screen
    .queryAllByRole('listitem')
    .map((li) => li.querySelector('a[href^="/jobs/"]')?.textContent ?? '')
    .filter((t) => t.startsWith('TG '));

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

const pager = () => screen.getAllByRole('navigation', { name: 'Pages' });

describe('job list paging', () => {
  it('shows 25 jobs per page with page links that keep the tab and filters', async () => {
    for (let i = 0; i < 27; i++) await insertJob({ id: `pg-${String(i).padStart(2, '0')}`, title: `TG pagerzz ${i}`, score: 60 });
    await renderList({ q: 'pagerzz', sort: 'newest' });
    expect(cardTitles()).toHaveLength(25);
    expect(pager()).toHaveLength(2); // above and below the list
    expect(within(pager()[0]).getByText('1–25 of 27 jobs')).toBeInTheDocument();
    expect(within(pager()[0]).getByRole('link', { name: 'Next →' })).toHaveAttribute('href', '/?status=new&q=pagerzz&sort=newest&page=2');

    document.body.innerHTML = '';
    await renderList({ q: 'pagerzz', sort: 'newest', page: '2' });
    expect(cardTitles()).toHaveLength(2);
    expect(within(pager()[0]).getByText('26–27 of 27 jobs')).toBeInTheDocument();
    // Tabs start again at page 1.
    expect(within(screen.getByRole('navigation', { name: 'Job status' })).getByRole('link', { name: /^Applied/ })).toHaveAttribute(
      'href',
      '/?status=applied&q=pagerzz&sort=newest',
    );
  });

  it('the visa filter shows only offered or not-needed jobs, and page links keep it', async () => {
    for (let i = 0; i < 26; i++)
      await insertJob({ id: `pv-${String(i).padStart(2, '0')}`, title: `TG pagerzz ${i}`, score: 60, visa_evidence: 'offered' });
    await insertJob({ id: 'pv-silent', title: 'TG pagerzz silent', score: 60, visa_evidence: 'silent' });
    await renderList({ q: 'pagerzz', visa: '1' });
    expect(within(pager()[0]).getByText('1–25 of 26 jobs')).toBeInTheDocument();
    expect(within(pager()[0]).getByRole('link', { name: 'Next →' })).toHaveAttribute('href', '/?status=new&q=pagerzz&visa=1&page=2');
    expect(screen.getByRole('checkbox', { name: 'Visa/relocation offered (or not needed)' })).toBeChecked();
  });

  it('shows 10, 50 or 100 per page when chosen, and every link keeps the size', async () => {
    for (let i = 0; i < 27; i++) await insertJob({ id: `ps-${String(i).padStart(2, '0')}`, title: `TG pagerzz ${i}`, score: 60 });
    await renderList({ q: 'pagerzz', size: '10', page: '2' });
    expect(cardTitles()).toHaveLength(10);
    expect(within(pager()[0]).getByText('11–20 of 27 jobs')).toBeInTheDocument();
    expect(within(pager()[0]).getByRole('link', { name: 'Next →' })).toHaveAttribute('href', '/?status=new&q=pagerzz&size=10&page=3');
    expect(within(screen.getByRole('navigation', { name: 'Job status' })).getByRole('link', { name: /^Applied/ })).toHaveAttribute(
      'href',
      '/?status=applied&q=pagerzz&size=10',
    );
    expect(screen.getByRole('combobox', { name: 'Jobs per page' })).toHaveValue('10');

    document.body.innerHTML = '';
    await renderList({ q: 'pagerzz', size: '50' });
    expect(cardTitles()).toHaveLength(27);
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();

    document.body.innerHTML = '';
    await renderList({ q: 'pagerzz', size: '7' }); // not offered: the default 25
    expect(cardTitles()).toHaveLength(25);
    expect(screen.getByRole('combobox', { name: 'Jobs per page' })).toHaveValue('25');
  });

  it('has no page links when the list fits on one page', async () => {
    await insertJob({ id: 'pg-one', title: 'TG pagerzz one' });
    await renderList({ q: 'pagerzz' });
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
  });
});
