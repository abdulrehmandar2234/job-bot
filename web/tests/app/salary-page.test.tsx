// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/page';
import { cleanupDb, closeDb, ensureSchema, insertJob } from '../helpers/db';

vi.mock('@/app/actions', () => ({ fetchNow: vi.fn(), setStatus: vi.fn(), prepare: vi.fn(), aiReview: vi.fn(), dismissTask: vi.fn() }));
// TaskWatcher (a client component) needs the app router; the page tests render outside Next.
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));

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
async function renderPage(searchParams: Record<string, string> = {}) {
  const shell = Page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as Parameters<typeof Page>[0]);
  return render(<>{await resolve(shell)}</>);
}

const cards = () => screen.queryAllByRole('listitem').filter((li) => li.querySelector('a[href^="/jobs/"]')?.textContent?.startsWith('TS '));
const titles = () => cards().map((li) => li.querySelector('a[href^="/jobs/"]')!.textContent!.replace(/ · .*/, '')).sort();

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

async function seed() {
  await insertJob({ id: 'sp-aed', title: 'TS dubai', salary_min: 20_000, salary_max: 25_000, salary_currency: 'AED', salary_period: 'month' });
  await insertJob({ id: 'sp-eur', title: 'TS amsterdam', country: 'NL', salary_min: 4_000, salary_max: 4_500, salary_currency: 'EUR', salary_period: 'month' });
  await insertJob({ id: 'sp-none', title: 'TS unknown' });
}

describe('salary on the job list', () => {
  it('shows the salary on the card', async () => {
    await seed();
    await renderPage();
    const card = cards().find((li) => li.textContent!.includes('TS dubai'))!;
    expect(within(card).getByText('💰 AED 20k–25k / month')).toBeInTheDocument();
    expect(cards().find((li) => li.textContent!.includes('TS unknown'))).not.toHaveTextContent('💰');
  });

  it('filters by min salary in another currency, keeping jobs without a salary', async () => {
    await seed();
    // EUR 5,000 a month = EUR 60k a year: AED 25k a month (~EUR 75k) passes, EUR 4.5k a month does not.
    await renderPage({ sal: '5000', cur: 'EUR', per: 'month' });
    expect(titles()).toEqual(['TS dubai', 'TS unknown']);
    expect(screen.getByRole('spinbutton', { name: 'Min salary' })).toHaveValue(5000);
  });

  it('"only with salary" hides jobs without one and the tabs keep the filter', async () => {
    await seed();
    await renderPage({ salonly: '1' });
    expect(titles()).toEqual(['TS amsterdam', 'TS dubai']);
    expect(within(screen.getByRole('navigation')).getAllByRole('link')[0].getAttribute('href')).toContain('salonly=1');
  });
});
