// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/page';
import { pool, statusCounts, type Status } from '@/lib/db';
import { cleanupDb, closeDb, daysAgo, ensureSchema, insertFetchRun, insertJob } from '../helpers/db';

vi.mock('@/app/actions', () => ({ fetchNow: vi.fn(), setStatus: vi.fn(), prepare: vi.fn(), aiReview: vi.fn(), dismissTask: vi.fn() }));
// TaskWatcher (a client component) needs the app router; the page tests render outside Next.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));

/**
 * Page is a sync shell with async server components inside <Suspense> (the Dashboard, and the fetch warning in the
 * header). Walk the shell, await each of them like the server would and render its output in place of the fallback.
 */
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

async function renderPage(searchParams: Record<string, string | string[]> = {}) {
  const shell = Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as Parameters<typeof Page>[0]);
  return render(<>{await resolve(shell)}</>);
}

// Other rows may be in the shared test database: only look at our cards (titles start with "TG ").
const cards = () => screen.queryAllByRole('listitem').filter((li) => li.querySelector('a[href^="/jobs/"]')?.textContent?.startsWith('TG '));
const titles = () => cards().map((li) => li.querySelector('a[href^="/jobs/"]')!.textContent!.replace(/ · .*/, ''));
const tab = (label: string) => within(screen.getByRole('navigation')).getByRole('link', { name: new RegExp(`^${label} \\d+$`) });

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('job list page', () => {
  it('shows the header, the Fetch button and the Bayt instructions', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Job Bot');
    expect(screen.getByRole('button', { name: 'Fetch new jobs' })).toHaveAttribute('type', 'submit');
    expect(screen.getByText('Add jobs from Bayt')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Bayt ↗' })).toHaveAttribute('href', 'https://www.bayt.com/en/uae/jobs/laravel-jobs/');
  });

  it('links to the analytics page from the header', async () => {
    await renderPage();
    expect(within(screen.getByRole('banner')).getByRole('link', { name: 'Analytics' })).toHaveAttribute('href', '/analytics');
  });

  it('warns in the header when the latest fetch had errors, and not once a clean fetch follows', async () => {
    await insertFetchRun({
      finished_at: new Date(),
      errors: [
        { company: 'Acme', error: 'HTTP 500' },
        { company: 'Globex', error: 'timeout' },
      ],
    });
    const { unmount } = await renderPage();
    expect(within(screen.getByRole('banner')).getByRole('link', { name: '⚠ Last fetch: 2 errors' })).toHaveAttribute(
      'href',
      '/analytics#fetch',
    );
    unmount();

    await insertFetchRun({ finished_at: new Date(), errors: [] });
    await renderPage();
    expect(screen.queryByText(/Last fetch: \d+ error/)).not.toBeInTheDocument();
  });

  it('shows a tab per status with counts that skip duplicates and filtered jobs outside target countries', async () => {
    const before = await statusCounts();
    const n = (s: Status, added: number) => `${(before[s] ?? 0) + added}`;
    const primary = await insertJob({ id: 'tabs-1', title: 'TG one', status: 'new' });
    await insertJob({ id: 'tabs-2', title: 'TG two', status: 'new' });
    await insertJob({ id: 'tabs-dup', title: 'TG one copy', status: 'new', source: 'linkedin', duplicate_of: primary });
    await insertJob({ id: 'tabs-3', title: 'TG applied', status: 'applied', applied_at: new Date() });
    await insertJob({ id: 'tabs-4', title: 'TG filtered', status: 'filtered', filter_reason: 'no visa' });
    await insertJob({ id: 'tabs-5', title: 'TG nowhere', status: 'filtered', country: null, filter_reason: 'country' });

    await renderPage();
    const nav = screen.getByRole('navigation');
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => a.textContent!.replace(/ \d+$/, '')),
    ).toEqual([
      'Matching',
      'Prepared',
      'Applied',
      'Needs follow-up',
      'Interview',
      'Offer',
      'Rejected',
      'Skipped',
      'Expired',
      'Filtered out',
    ]);
    expect(tab('Matching')).toHaveTextContent(`Matching ${n('new', 2)}`);
    expect(tab('Applied')).toHaveTextContent(`Applied ${n('applied', 1)}`);
    expect(tab('Filtered out')).toHaveTextContent(`Filtered out ${n('filtered', 1)}`);
    expect(tab('Offer')).toHaveTextContent(`Offer ${n('offer', 0)}`);
    expect(tab('Matching')).toHaveAttribute('href', '/?status=new');
    expect(tab('Matching')).toHaveClass('font-medium');
    expect(tab('Applied')).not.toHaveClass('font-medium');

    expect(screen.getByText('Matching now').nextElementSibling).toHaveTextContent(n('new', 2));
    expect(screen.getByText('Applied (7 days)').nextElementSibling!.textContent).toMatch(/^\d+$/);
  });

  it('shows the last finished fetch run', async () => {
    await insertFetchRun({
      started_at: new Date(Date.now() - 3 * 3_600_000),
      finished_at: new Date(Date.now() - 2 * 3_600_000),
      checked: 1234,
    });
    await renderPage();
    const stat = screen.getByText('Last fetch').parentElement!;
    expect(stat).toHaveTextContent('2h ago');
    expect(stat).toHaveTextContent('1234 postings checked');
  });

  it('keeps the filters in the tab links and the filter form', async () => {
    await renderPage({ status: 'applied', country: 'AE', min: '60', q: 'laravel', days: '7', sort: 'newest' });
    expect(tab('Matching')).toHaveAttribute('href', '/?status=new&country=AE&min=60&q=laravel&days=7&sort=newest');
    expect(tab('Applied')).toHaveClass('font-medium');

    const form = screen.getByRole('button', { name: 'Apply filters' }).closest('form')!;
    expect(form.querySelector('input[name="status"]')).toHaveValue('applied');
    expect(within(form).getByPlaceholderText('Search company or title')).toHaveValue('laravel');
    expect(form.querySelector('select[name="country"]')).toHaveValue('AE');
    expect(form.querySelector('select[name="min"]')).toHaveValue('60');
    expect(form.querySelector('select[name="days"]')).toHaveValue('7');
    expect(form.querySelector('select[name="sort"]')).toHaveValue('newest');
  });

  it('falls back to the Matching tab and drops unknown filter values', async () => {
    await insertJob({ id: 'fb-1', title: 'TG matching', status: 'new' });
    await renderPage({ status: 'bogus', country: 'XX', min: 'abc', sort: 'weird' });
    expect(tab('Matching')).toHaveClass('font-medium');
    expect(tab('Matching')).toHaveAttribute('href', '/?status=new');
    expect(titles()).toContain('TG matching');
    const form = screen.getByRole('button', { name: 'Apply filters' }).closest('form')!;
    expect(form.querySelector('select[name="country"]')).toHaveValue('');
    expect(form.querySelector('select[name="sort"]')).toHaveValue('score');
  });

  it('badges a card when you know someone at the company to ask for a referral', async () => {
    await insertJob({ id: 'pg-ref-a', title: 'TG Ref A', company: 'Refco Inc.' });
    await insertJob({ id: 'pg-ref-b', title: 'TG Ref B', company: 'Other' });
    const applied = await insertJob({ id: 'pg-ref-c', title: 'TG Ref C', company: 'REFCO', status: 'applied' });
    await pool.query(`INSERT INTO contacts (job_id, name, referral_status) VALUES ($1, 'Rita', 'to ask')`, [applied]);
    await renderPage();
    const card = (t: string) => cards().find((li) => li.textContent!.includes(t))!;
    expect(within(card('TG Ref A')).getByText('🤝 Ask Rita for a referral')).toBeInTheDocument();
    expect(card('TG Ref B')).not.toHaveTextContent('referral');
  });

  it('searches company and title, case-insensitively', async () => {
    await insertJob({ id: 's-1', title: 'TG Laravel Developer', company: 'Acme' });
    await insertJob({ id: 's-2', title: 'TG Node Engineer', company: 'LaravelShop' });
    await insertJob({ id: 's-3', title: 'TG React Engineer', company: 'Other' });
    await renderPage({ q: 'laravel' });
    expect(titles().sort()).toEqual(['TG Laravel Developer', 'TG Node Engineer']);
  });

  it('filters by country and by minimum score, preferring the AI score', async () => {
    await insertJob({ id: 'c-ae', title: 'TG Dubai', country: 'AE', score: 70 });
    await insertJob({ id: 'c-sa', title: 'TG Riyadh', country: 'SA', score: 70 });
    await insertJob({ id: 'm-ai-low', title: 'TG AI low', country: 'AE', score: 90, ai_score: 40 });
    await insertJob({ id: 'm-ai-high', title: 'TG AI high', country: 'AE', score: 30, ai_score: 75 });
    await insertJob({ id: 'm-kw-low', title: 'TG kw low', country: 'AE', score: 55 });

    const { unmount } = await renderPage({ country: 'SA' });
    expect(titles()).toEqual(['TG Riyadh']);
    expect(cards()[0]).toHaveTextContent('🇸🇦 Saudi');
    unmount();

    await renderPage({ country: 'AE', min: '60' });
    expect(titles().sort()).toEqual(['TG AI high', 'TG Dubai']);
  });

  it('sorts matching jobs by AI score first, then keyword score', async () => {
    await insertJob({ id: 'o-kw90', title: 'TG kw 90', score: 90 });
    await insertJob({ id: 'o-ai60', title: 'TG ai 60', score: 20, ai_score: 60 });
    await insertJob({ id: 'o-kw70', title: 'TG kw 70', score: 70 });
    await insertJob({ id: 'o-ai85', title: 'TG ai 85', score: 40, ai_score: 85 });
    await renderPage();
    expect(titles()).toEqual(['TG ai 85', 'TG ai 60', 'TG kw 90', 'TG kw 70']);
    const [first, , third] = cards();
    expect(first).toHaveTextContent('85AI');
    expect(third).toHaveTextContent('90kw');
  });

  it('sorts by posting date with "Newest first"', async () => {
    await insertJob({ id: 'n-old', title: 'TG old', score: 90, posted_at: daysAgo(5) });
    await insertJob({ id: 'n-new', title: 'TG new', score: 10, posted_at: daysAgo(1) });
    await renderPage({ sort: 'newest' });
    expect(titles()).toEqual(['TG new', 'TG old']);
  });

  it('shows a job posted on several sites once, with a link per site', async () => {
    const primary = await insertJob({ id: 'd-1', title: 'TG shared', source: 'greenhouse', url: 'https://boards.greenhouse.io/acme/1' });
    await insertJob({ id: 'd-2', title: 'TG shared', source: 'linkedin', url: 'https://linkedin.com/jobs/9', duplicate_of: primary });
    await insertJob({
      id: 'd-3',
      title: 'TG shared',
      source: 'bayt',
      url: 'https://www.bayt.com/en/uae/jobs/x-1234567/',
      duplicate_of: primary,
    });
    await renderPage();
    expect(titles()).toEqual(['TG shared']);
    const card = cards()[0];
    expect(within(card).getByRole('link', { name: 'TG shared · Acme' })).toHaveAttribute('href', `/jobs/${encodeURIComponent(primary)}`);
    expect(card).toHaveTextContent('Posted on:');
    expect(within(card).getByRole('link', { name: 'Company site ↗' })).toHaveAttribute('href', 'https://boards.greenhouse.io/acme/1');
    expect(within(card).getByRole('link', { name: 'LinkedIn ↗' })).toHaveAttribute('href', 'https://linkedin.com/jobs/9');
    expect(within(card).getByRole('link', { name: 'Bayt ↗' })).toHaveAttribute('href', 'https://www.bayt.com/en/uae/jobs/x-1234567/');
  });

  it('shows card details: location, visa, AI review, skills, flags and notes', async () => {
    await insertJob({
      id: 'card',
      title: 'TG card',
      company: 'Globex',
      country: 'NL',
      location: 'Amsterdam',
      visa: 'IND sponsor',
      matched: ['laravel'],
      missing: ['go'],
      flags: ['Dutch required'],
      notes: 'Ask about relocation',
      score: 60,
      ai_score: 77,
      ai_verdict: 'good fit',
      ai_summary: 'Strong PHP match',
      ai_reasons: ['PHP'],
      ai_gaps: ['Go'],
      ai_flags: [],
    });
    await renderPage();
    const card = cards()[0];
    expect(card).toHaveTextContent('🇳🇱 Netherlands · Amsterdam · ✓ IND sponsor');
    expect(card).toHaveTextContent('AI · good fit: Strong PHP match');
    for (const text of ['laravel', 'go', 'Dutch required', '📝 Ask about relocation', '✓ PHP', '– Go'])
      expect(card).toHaveTextContent(text);
    expect(within(card).getByRole('link', { name: 'Open job ↗' })).toHaveAttribute('href', 'https://example.com/webtest:card');
    expect(card).not.toHaveTextContent('✗');
  });

  it('shows the reason on the Filtered out tab, and hides filtered jobs outside target countries', async () => {
    await insertJob({ id: 'f-1', title: 'TG needs Arabic', status: 'filtered', filter_reason: 'Arabic required', score: 40 });
    await insertJob({ id: 'f-2', title: 'TG US only', status: 'filtered', country: null, filter_reason: 'not a target country' });
    await renderPage({ status: 'filtered' });
    expect(titles()).toEqual(['TG needs Arabic']);
    expect(cards()[0]).toHaveTextContent('✗ Arabic required');
    expect(within(cards()[0]).getByRole('button', { name: 'Prepare anyway' })).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    await insertJob({ id: 'e-1', title: 'TG something', status: 'new' });
    await renderPage({ q: 'no-such-company-xyz' });
    expect(screen.getByText('No jobs here.')).toBeInTheDocument();
    expect(cards()).toHaveLength(0);
  });

  it('shows running tasks and failures above the stats, and the job card in progress', async () => {
    const job = await insertJob({ id: 'busy', title: 'TG busy', company: 'Busyco' });
    await pool.query(`INSERT INTO tasks (kind, job_id, status) VALUES ('fetch', NULL, 'queued'), ('prepare', $1, 'queued')`, [job]);
    await pool.query(`INSERT INTO tasks (kind, job_id, status, error) VALUES ('ai_review', $1, 'failed', 'Claude is offline')`, [job]);

    await renderPage();
    const working = screen.getAllByRole('status').find((s) => s.textContent!.startsWith('Working…'))!;
    expect(working).toHaveTextContent('Fetching new jobs · Preparing CV + letter (Busyco — TG busy)');
    expect(screen.getByRole('alert')).toHaveTextContent(/AI reviewing \(Busyco — TG busy\) failed\s*Claude is offline/);
    const card = cards().find((li) => li.textContent!.includes('TG busy'))!;
    expect(within(card).getByRole('status')).toHaveTextContent('Preparing CV + letter…');
    expect(within(card).queryByRole('button', { name: 'Prepare CV + letter' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'AI review' })).toBeInTheDocument();
  });
});
