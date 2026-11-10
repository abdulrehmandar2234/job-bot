// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterContext } from 'next/dist/shared/lib/router-context.shared-runtime';
import Page from '@/app/page';
import { BOT_ROOT } from '@/lib/bot';
import { pool, statusCounts, type Status } from '@/lib/db';
import { cleanupDb, closeDb, dateDaysAgo, ensureSchema, insertFetchRun, insertJob } from '../helpers/db';

// The header and first-run banner read config.json per request (connection()); these tests render outside Next.
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  connection: async () => {},
}));
vi.mock('@/app/actions', () => ({
  skipSelected: vi.fn(),
  writeLetter: vi.fn(),
  fetchNow: vi.fn(),
  setStatus: vi.fn(),
  prepare: vi.fn(),
  aiReview: vi.fn(),
  dismissTask: vi.fn(),
}));
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

async function renderPage(searchParams: Record<string, string | string[]> = {}, router?: object) {
  const shell = Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as Parameters<typeof Page>[0]);
  const page = <>{await resolve(shell)}</>;
  // next/form navigates through the router in context; without one it falls back to a native (full page) submit.
  return render(router ? <RouterContext.Provider value={router as never}>{page}</RouterContext.Provider> : page);
}

// Other rows may be in the shared test database: only look at our cards (titles start with "TG ").
const cards = () => screen.queryAllByRole('listitem').filter((li) => li.querySelector('a[href^="/jobs/"]')?.textContent?.startsWith('TG '));
const titles = () => cards().map((li) => li.querySelector('a[href^="/jobs/"]')!.textContent!.replace(/ · .*/, ''));
const tab = (label: string) => within(screen.getByRole('navigation')).getByRole('link', { name: new RegExp(`^${label} \\d+$`) });

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('job list page', () => {
  it('gives each card the hooks of the keyboard triage layer, and points at its shortcut list', async () => {
    const id = await insertJob({ id: 'kbd', title: 'TG Keyboard', status: 'new', score: 99 });
    await renderPage();
    const [card] = cards();
    expect(card).toHaveAttribute('data-job-id', id);
    expect(card).toHaveAttribute('tabindex', '-1');
    expect(within(card).getByRole('link', { name: /TG Keyboard/ })).toHaveAttribute('aria-keyshortcuts', 'o');
    expect(screen.getByText(/shows every shortcut/)).toBeInTheDocument();
  });

  it('offers bulk skip on the Matching and Prepared tabs only, not in the pipeline or a search across every tab', async () => {
    await insertJob({ id: 'bulk-new', title: 'TG Bulk new', status: 'new', score: 99 });
    await insertJob({ id: 'bulk-prepared', title: 'TG Bulk prepared', status: 'prepared', score: 99 });
    await insertJob({ id: 'bulk-applied', title: 'TG Bulk applied', status: 'applied', score: 99 });
    const bulkHint = () => screen.queryByText(/selects for bulk skip/);
    const cases: [Record<string, string>, boolean][] = [
      [{}, true],
      [{ status: 'prepared' }, true],
      [{ status: 'new', q: 'TG Bulk', in: 'tab' }, true],
      [{ status: 'applied' }, false],
      [{ view: 'followup' }, false],
      [{ status: 'new', q: 'TG Bulk' }, false], // every tab: applied jobs are in the results
    ];
    for (const [params, selectable] of cases) {
      const view = await renderPage(params);
      expect(Boolean(bulkHint()), JSON.stringify(params)).toBe(selectable);
      view.unmount();
    }
    await renderPage({ status: 'applied' });
    expect(screen.getByText(/act on the focused job/)).toBeInTheDocument();
  });

  it('shows the header, the Fetch button and the Bayt instructions', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Job Bot');
    expect(screen.getByRole('button', { name: 'Fetch new jobs' })).toHaveAttribute('type', 'submit');
    expect(screen.getByText('Add jobs from Bayt')).toBeInTheDocument();
    // The board of the first target country Bayt serves (config.default.json starts with the UAE), no stack in it.
    expect(screen.getByRole('link', { name: 'Open Bayt ↗' })).toHaveAttribute('href', 'https://www.bayt.com/en/uae/jobs/');
  });

  it("describes the target markets from config.json, the owner's as before", async () => {
    await renderPage();
    expect(
      within(screen.getByRole('banner')).getByText(
        'UAE · Saudi Arabia · Netherlands with visa sponsorship · Pakistan onsite, plus remote roles open to Pakistan',
      ),
    ).toBeInTheDocument();
    const countries = [...document.querySelectorAll('select[name="country"] option')].map((o) => o.textContent);
    expect(countries).toEqual(['All countries', '🇦🇪 UAE', '🇸🇦 Saudi', '🇳🇱 Netherlands', '🇵🇰 Pakistan', '🌍 Remote (from Pakistan)']);
  });

  it('follows another config.json: countries, labels and header', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-bot-page-'));
    const cfg = {
      countries: { DE: { name: 'Germany', visa: 'employer', match: 'berlin', needsVisa: false } },
      remote: { enabled: true, from: 'Portugal' },
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'config.json'));
    try {
      await renderPage();
      expect(within(screen.getByRole('banner')).getByText('Germany onsite, plus remote roles open to Portugal')).toBeInTheDocument();
      const countries = [...document.querySelectorAll('select[name="country"] option')].map((o) => o.textContent);
      expect(countries).toEqual(['All countries', '🇩🇪 Germany', '🌍 Remote (from Portugal)']);
      // No target country Bayt serves: Bayt's home page, never the owner's country or stack.
      expect(screen.getByRole('link', { name: 'Open Bayt ↗' })).toHaveAttribute('href', 'https://www.bayt.com/en/');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('shows the first-run banner until the profile is complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-bot-page-'));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    try {
      const { unmount } = await renderPage();
      expect(screen.getByText('Welcome! Set up your profile first.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open Settings' })).toHaveAttribute('href', '/settings');
      unmount();
      vi.stubEnv('JOB_BOT_APPLICANT', join(BOT_ROOT, 'tests', 'fixtures', 'applicant-owner.json'));
      await renderPage();
      expect(screen.queryByText(/Set up your profile|profile is incomplete/)).not.toBeInTheDocument();
    } finally {
      vi.unstubAllEnvs();
    }
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
    // Every tab link carries `days`, so proxy.ts never has to redirect it to put the saved filters back.
    expect(tab('Matching')).toHaveAttribute('href', '/?status=new&days=1');
    expect(tab('Matching')).toHaveClass('font-medium');
    expect(tab('Applied')).not.toHaveClass('font-medium');

    expect(screen.getByText('Matching now').nextElementSibling).toHaveTextContent(n('new', 2));
    expect(screen.getByText('Applied (7 days)').nextElementSibling!.textContent).toMatch(/^\d+$/);
  });

  it('hints at tabs beyond the fold: the strip hides its scrollbar but carries the edge-shadow class', async () => {
    await renderPage();
    const nav = screen.getByRole('navigation', { name: 'Job status' });
    expect(nav).toHaveClass('overflow-x-auto', '[scrollbar-width:none]', 'scroll-x-hint');
    // The class is real CSS: an edge shadow whose covers scroll with the content (globals.css), in theme colours.
    const css = readFileSync(join(import.meta.dirname, '..', '..', 'app', 'globals.css'), 'utf8');
    const rule = css.match(/\.scroll-x-hint\s*{[^}]*}/)?.[0];
    expect(rule).toBeDefined();
    expect(rule).toContain('var(--background)');
    expect(rule).toContain('var(--foreground)');
    expect(rule).toContain('local');
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
    // in=tab: a search narrowed to this tab (without it, a search looks in every tab: tests/app/page-paging.test.tsx).
    await renderPage({ status: 'applied', country: 'AE', min: '60', q: 'laravel', in: 'tab', days: '7', sort: 'newest' });
    expect(tab('Matching')).toHaveAttribute('href', '/?status=new&country=AE&min=60&q=laravel&in=tab&days=7&sort=newest');
    expect(tab('Applied')).toHaveClass('font-medium');

    const form = screen.getByRole('button', { name: 'Apply filters' }).closest('form')!;
    expect(form.querySelector('input[name="status"]')).toHaveValue('applied');
    expect(within(form).getByRole('searchbox', { name: 'Search company or title' })).toHaveValue('laravel');
    expect(within(form).getByRole('combobox', { name: 'Country' })).toHaveValue('AE');
    expect(within(form).getByRole('combobox', { name: 'Minimum score' })).toHaveValue('60');
    expect(within(form).getByRole('combobox', { name: 'Posted within' })).toHaveValue('7');
    expect(within(form).getByRole('combobox', { name: 'Sort' })).toHaveValue('newest');
  });

  it('lays the filters out in two rows of equal-height, labelled controls', async () => {
    await renderPage({ visa: '1', salonly: '1' });
    const form = screen.getByRole('form', { name: 'Job filters' });
    const [textRow, choiceRow] = [...form.children].filter((el): el is HTMLElement => el.tagName === 'DIV');
    // Row 1: the text filters (search, min salary with its units) and Apply at the end.
    expect(within(textRow).getByRole('searchbox', { name: 'Search company or title' })).toBeInTheDocument();
    expect(within(textRow).getByRole('spinbutton', { name: 'Min salary' })).toBeInTheDocument();
    expect(within(textRow).getByRole('combobox', { name: 'Salary currency' })).toBeInTheDocument();
    expect(within(textRow).getByRole('combobox', { name: 'Salary period' })).toBeInTheDocument();
    const apply = within(textRow).getByRole('button', { name: 'Apply filters' });
    expect(textRow.lastElementChild).toBe(apply);
    expect(apply).toHaveClass('ml-auto');
    // Row 2: the choices.
    for (const name of ['Country', 'Minimum score', 'Posted within', 'Sort', 'Jobs per page'])
      expect(within(choiceRow).getByRole('combobox', { name })).toBeInTheDocument();
    const visa = within(choiceRow).getByRole('checkbox', { name: 'Visa/relocation offered (or not needed)' });
    expect(visa).toBeChecked();
    // Checkboxes are pill toggles; every other control is h-9.
    expect(visa.closest('label')).toHaveClass('toggle');
    expect(screen.getByRole('checkbox', { name: 'only with salary' }).closest('label')).toHaveClass('toggle');
    // The two toggles sit together after the selects, so they wrap as one group.
    expect(
      within(screen.getByTestId('filter-toggles'))
        .getAllByRole('checkbox')
        .map((c) => c.getAttribute('name')),
    ).toEqual(['salonly', 'visa']);
    expect(choiceRow.lastElementChild).toBe(screen.getByTestId('filter-toggles'));
    for (const el of form.querySelectorAll('input:not([type="hidden"]):not([type="checkbox"]), select, button'))
      expect(el).toHaveClass('h-9');
  });

  it('applies the page size, sort and other choices on change, back on page 1; typed text waits for Apply', async () => {
    const sent: Record<string, string>[] = [];
    const submit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (this: HTMLFormElement) {
      sent.push(Object.fromEntries(new FormData(this)) as Record<string, string>);
    });
    try {
      await renderPage({ status: 'applied', q: 'laravel', sort: 'newest', page: '3' });
      const form = screen.getByRole('form', { name: 'Job filters' });
      fireEvent.change(within(form).getByRole('combobox', { name: 'Jobs per page' }), { target: { value: '50' } });
      expect(submit).toHaveBeenCalledTimes(1);
      // The other filters are kept; the page is not in the form, so the new size starts on page 1.
      expect(sent[0]).toMatchObject({ status: 'applied', q: 'laravel', sort: 'newest', size: '50' });
      expect(sent[0]).not.toHaveProperty('page');
      for (const name of ['Country', 'Minimum score', 'Posted within', 'Sort']) {
        const select = within(form).getByRole('combobox', { name }) as HTMLSelectElement;
        fireEvent.change(select, { target: { value: select.options[1].value } });
      }
      fireEvent.click(within(form).getByRole('checkbox', { name: 'Visa/relocation offered (or not needed)' }));
      fireEvent.click(within(form).getByRole('checkbox', { name: 'only with salary' }));
      expect(submit).toHaveBeenCalledTimes(7);
      // Text and the salary units wait for Apply filters.
      fireEvent.change(within(form).getByRole('searchbox', { name: 'Search company or title' }), { target: { value: 'php' } });
      fireEvent.change(within(form).getByRole('spinbutton', { name: 'Min salary' }), { target: { value: '5000' } });
      fireEvent.change(within(form).getByRole('combobox', { name: 'Salary currency' }), { target: { value: 'USD' } });
      fireEvent.change(within(form).getByRole('combobox', { name: 'Salary period' }), { target: { value: 'month' } });
      expect(submit).toHaveBeenCalledTimes(7);
      expect(within(form).getByRole('button', { name: 'Apply filters' })).toHaveAttribute('type', 'submit');
    } finally {
      submit.mockRestore();
    }
  });

  it('applies filters with a client-side navigation, not a full page load, keeping the scroll position', async () => {
    const push = vi.fn();
    await renderPage({ status: 'applied', sort: 'newest' }, { push, replace: vi.fn(), prefetch: vi.fn(async () => {}) });
    const form = screen.getByRole('form', { name: 'Job filters' });
    fireEvent.change(within(form).getByRole('searchbox', { name: 'Search company or title' }), { target: { value: 'php' } });
    const submitted = fireEvent.submit(form);
    // The router navigates; the browser's own submit (a full page load) is cancelled.
    expect(submitted).toBe(false);
    expect(push).toHaveBeenCalledTimes(1);
    const [href, , options] = push.mock.calls[0];
    const url = new URL(href);
    expect(url.pathname).toBe('/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ status: 'applied', q: 'php', sort: 'newest' });
    expect(options).toMatchObject({ scroll: false });
  });

  it('marks only the active status tab as the current page', async () => {
    await renderPage({ status: 'applied' });
    expect(tab('Applied')).toHaveAttribute('aria-current', 'page');
    const current = within(screen.getByRole('navigation', { name: 'Job status' }))
      .getAllByRole('link')
      .filter((a) => a.hasAttribute('aria-current'));
    expect(current).toEqual([tab('Applied')]);
    expect(tab('Matching')).not.toHaveAttribute('aria-current');
  });

  it('falls back to the Matching tab and drops unknown filter values', async () => {
    await insertJob({ id: 'fb-1', title: 'TG matching', status: 'new' });
    await renderPage({ status: 'bogus', country: 'XX', min: 'abc', sort: 'weird' });
    expect(tab('Matching')).toHaveClass('font-medium');
    expect(tab('Matching')).toHaveAttribute('href', '/?status=new&days=1');
    expect(titles()).toContain('TG matching');
    expect(tab('Matching')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveValue('score');
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

  it('shows jobs posted in the last 24 hours by default on Matching, and all of them with "any time"', async () => {
    await insertJob({ id: 'd-old', title: 'TG week old', posted_at: dateDaysAgo(5) });
    await insertJob({ id: 'd-new', title: 'TG today', posted_at: new Date(Date.now() - 3_600_000) });
    await renderPage({});
    expect(titles()).toEqual(['TG today']);
    expect(screen.getByRole('combobox', { name: 'Posted within' })).toHaveValue('1');
    expect(tab('Applied')).toHaveAttribute('href', '/?status=applied&days=1');

    document.body.innerHTML = '';
    await renderPage({ days: '0' });
    expect(titles().sort()).toEqual(['TG today', 'TG week old']);
    expect(screen.getByRole('combobox', { name: 'Posted within' })).toHaveValue('0');
    expect(tab('Applied')).toHaveAttribute('href', '/?status=applied&days=0');
  });

  it('never hides older jobs in the other tabs by when they were posted', async () => {
    await insertJob({ id: 'd-applied', title: 'TG applied long ago', status: 'applied', posted_at: dateDaysAgo(30) });
    await renderPage({ status: 'applied', days: '1' });
    expect(titles()).toEqual(['TG applied long ago']);
  });

  it('sorts by posting date with "Newest first"', async () => {
    await insertJob({ id: 'n-old', title: 'TG old', score: 90, posted_at: dateDaysAgo(5) });
    await insertJob({ id: 'n-new', title: 'TG new', score: 10, posted_at: dateDaysAgo(1) });
    await renderPage({ sort: 'newest', days: '0' });
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
    expect(within(card).getByRole('link', { name: 'TG shared · Acme' })).toHaveAttribute(
      'href',
      `/jobs/${encodeURIComponent(primary)}?from=${encodeURIComponent('/?status=new&days=1')}`,
    );
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
      visa: 'Netherlands: company is an IND recognised sponsor, but the posting does not mention visa or relocation',
      visa_evidence: 'can-sponsor',
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
    expect(card).toHaveTextContent('🇳🇱 Netherlands · Amsterdam · ? Company can sponsor, posting does not say');
    expect(within(card).getByText('? Company can sponsor, posting does not say')).toHaveAttribute(
      'title',
      expect.stringMatching(/IND recognised sponsor/),
    );
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

  it('says how many jobs the filters hide when the list is empty, with "Show any time" and "Reset filters"', async () => {
    await insertJob({ id: 'e-hidden', title: 'TG emptyzz', status: 'new', score: 50, posted_at: dateDaysAgo(5) });
    await renderPage({ q: 'emptyzz', in: 'tab', min: '80' });
    expect(cards()).toHaveLength(0);
    expect(screen.getByText('No jobs here.')).toBeInTheDocument();
    expect(screen.getByText('1 job matches without the date and score filters.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Show any time' })).toHaveAttribute('href', '/?status=new&min=80&q=emptyzz&in=tab&days=0');
    // proxy.ts clears the remembered filters on reset=1 and redirects to the same tab and search.
    expect(screen.getByRole('link', { name: 'Reset filters' })).toHaveAttribute('href', '/?status=new&q=emptyzz&reset=1');
  });

  it('offers only "Reset filters" when the date is not one of the filters, and says when they hide nothing', async () => {
    await renderPage({ status: 'applied', q: 'nosuchjobzz', in: 'tab', min: '80' });
    expect(screen.getByText('None without the score filter either.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Show any time' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reset filters' })).toHaveAttribute('href', '/?status=applied&q=nosuchjobzz&reset=1');
  });

  it('links each card to its job page with the list it came from, filters and page included', async () => {
    const id = await insertJob({ id: 'from-1', title: 'TG fromzz', status: 'applied' });
    await renderPage({ status: 'applied', q: 'fromzz', in: 'tab', country: 'AE', sort: 'newest' });
    const link = within(cards()[0]).getByRole('link', { name: /TG fromzz/ });
    const url = new URL(link.getAttribute('href')!, 'http://localhost');
    expect(url.pathname).toBe(`/jobs/${encodeURIComponent(id)}`);
    expect(url.searchParams.get('from')).toBe('/?status=applied&country=AE&q=fromzz&in=tab&days=1&sort=newest');
  });

  it('leaves room under the list for the bulk-skip bar where it can show', async () => {
    const view = await renderPage({ status: 'new' });
    expect(screen.getByTestId('job-list')).toHaveClass('pb-28');
    view.unmount();
    await renderPage({ status: 'applied' });
    expect(screen.getByTestId('job-list')).not.toHaveClass('pb-28');
  });

  it('shows running tasks and failures above the stats, and the job card in progress', async () => {
    const job = await insertJob({ id: 'busy', title: 'TG busy', company: 'Busyco' });
    await pool.query(`INSERT INTO tasks (kind, job_id, status) VALUES ('fetch', NULL, 'queued'), ('prepare', $1, 'queued')`, [job]);
    await pool.query(`INSERT INTO tasks (kind, job_id, status, error) VALUES ('ai_review', $1, 'failed', 'Claude is offline')`, [job]);

    await renderPage();
    const working = screen.getAllByRole('status').find((s) => s.textContent!.startsWith('Working…'))!;
    expect(working).toHaveTextContent('Fetching new jobs · Preparing CV (Busyco — TG busy)');
    expect(screen.getByRole('alert')).toHaveTextContent(/AI reviewing \(Busyco — TG busy\) failed\s*Claude is offline/);
    const card = cards().find((li) => li.textContent!.includes('TG busy'))!;
    expect(within(card).getByRole('status')).toHaveTextContent('Preparing CV…');
    expect(within(card).queryByRole('button', { name: 'Prepare CV' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'AI review' })).toBeInTheDocument();
  });
});
