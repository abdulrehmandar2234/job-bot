// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/analytics/page';
import { funnel } from '@/lib/analytics';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, daysAgo, ensureSchema, insertFetchRun, insertJob } from '../helpers/db';

// Real queries, but funnel() can be overridden to show the empty state whatever else is in the test database.
vi.mock('@/lib/analytics', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/analytics')>();
  return { ...mod, funnel: vi.fn(mod.funnel) };
});

/** The page is a sync shell with the async Analytics component inside <Suspense>; await it like the server would. */
async function renderAnalytics() {
  const shell = Page() as ReactElement<{ children: ReactNode[] }>;
  const suspense = shell.props.children.find(
    (c): c is ReactElement<{ children: ReactElement }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined)!;
  const body = suspense.props.children as ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
  return render(<>{await body.type(body.props)}</>);
}

const section = (name: string) => screen.getByRole('heading', { name }).closest('section')!;

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('analytics page', () => {
  it('has a title and a way back to the job list', () => {
    render(Page());
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Analytics');
    expect(screen.getByRole('link', { name: '← All jobs' })).toHaveAttribute('href', '/');
  });

  it('shows the funnel, response rates with n, time to response and weekly activity', async () => {
    const a = await insertJob({ id: 'pa-1', source: 'webtest-pg', status: 'rejected' });
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status, at) VALUES
      ($1, 'new', 'applied', $2), ($1, 'applied', 'interview', $3), ($1, 'interview', 'rejected', $4)`, [a, daysAgo(10), daysAgo(7), daysAgo(1)]);
    await insertJob({ id: 'pa-2', source: 'webtest-pg', status: 'applied', applied_at: daysAgo(2) });

    await renderAnalytics();
    expect(screen.queryByText('No applications yet')).not.toBeInTheDocument();

    const funnelList = within(section('Funnel')).getByRole('list');
    expect(within(funnelList).getAllByRole('listitem').map((li) => li.textContent!.replace(/[\d·%\s—]+$/, '')))
      .toEqual(['Matched', 'Prepared', 'Applied', 'Interview', 'Offer']);
    expect(section('Funnel')).toHaveTextContent(/Rejected \d+ · Skipped \d+/);

    const sourceTable = within(section('Response rate')).getByRole('table', { name: 'Source' });
    const row = within(sourceTable).getByText('webtest-pg').closest('tr')!;
    expect(row).toHaveTextContent('50% (1/2)');
    expect(row).toHaveAttribute('data-small', 'true');
    expect(row).toHaveClass('text-zinc-400');
    for (const name of ['Country', 'CV version', 'AI verdict']) expect(within(section('Response rate')).getByRole('table', { name })).toBeInTheDocument();

    expect(section('Time to response')).toHaveTextContent(/\d+\.\d days/);

    const weeks = within(section('Activity')).getByRole('table');
    expect(within(weeks).getAllByRole('row')).toHaveLength(13); // header + 12 weeks
    expect(within(weeks).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Week of', 'Applied', 'New matches']);
  });

  it('shows an empty state when there are no applications yet', async () => {
    vi.mocked(funnel).mockResolvedValueOnce({ matched: 3, prepared: 0, applied: 0, interview: 0, offer: 0, rejected: 0, skipped: 0 });
    await renderAnalytics();
    expect(screen.getByText('No applications yet')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Funnel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Response rate' })).not.toBeInTheDocument();
    // Activity and fetch health still help before the first application.
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Fetch health' })).toBeInTheDocument();
  });

  it('lists recent fetch runs, with the errors of a failed one expandable', async () => {
    await insertFetchRun({ finished_at: new Date(), checked: 812, inserted: 14, new_matches: 3,
      errors: [{ company: 'Acme', error: 'HTTP 503' }] });
    await renderAnalytics();
    const fetch = section('Fetch health');
    expect(fetch).toHaveAttribute('id', 'fetch');
    const run = within(fetch).getAllByRole('listitem')[0];
    expect(run).toHaveTextContent('812 checked · 14 inserted · 3 new matches · 1 error');
    expect(within(run).getByText('Show errors').closest('details')).not.toHaveAttribute('open');
    expect(run).toHaveTextContent('Acme: HTTP 503');
  });
});
