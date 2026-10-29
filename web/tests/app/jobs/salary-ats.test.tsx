// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { runBot } from '@/lib/bot';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('@/app/actions', () => ({
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

type AsyncEl = ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
const suspenseChild = (nodes: ReactNode) =>
  (Array.isArray(nodes) ? nodes : [nodes]).find(
    (c): c is ReactElement<{ children: AsyncEl }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined,
  )!.props.children;

/** Renders the job detail, and the CV keyword check inside it, after awaiting both like the server would. */
async function renderJob(id: string) {
  const shell = Page({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof Page>[0]) as ReactElement<{
    children: ReactNode;
  }>;
  const detail = suspenseChild(shell.props.children);
  const article = (await detail.type(detail.props)) as ReactElement<{ children: ReactNode[] }>;
  const ats = article.props.children.find(
    (c): c is ReactElement<{ jobId: string }> => isValidElement(c) && 'jobId' in (c.props as object),
  )!;
  const loader = suspenseChild((ats.type as (p: unknown) => ReactNode)(ats.props));
  render(
    <>
      {article}
      {await loader.type(loader.props)}
    </>,
  );
}

const id = PREFIX + 'sal-ats';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('job page: salary and CV keyword check', () => {
  it('shows the salary in the header and the keyword check for the job', async () => {
    await insertJob({
      id,
      title: 'Senior Laravel Developer',
      salary_min: 20_000,
      salary_max: 25_000,
      salary_currency: 'AED',
      salary_period: 'month',
    });
    vi.mocked(runBot).mockResolvedValue(
      JSON.stringify({
        label: 'laravel',
        source: 'suggested',
        present: ['Laravel'],
        hiddenButTrue: ['Docker'],
        missing: ['Kafka'],
        total: 3,
        suggestion: null,
      }),
    );
    await renderJob(id);
    expect(screen.getAllByText('💰 AED 20k–25k / month').length).toBeGreaterThan(0);
    expect(runBot).toHaveBeenCalledWith(['ats', id, '--json']);
    expect(screen.getAllByRole('heading', { name: /CV keyword check/ }).at(-1)).toHaveTextContent(
      'laravel (suggested) shows 1 of 3 job keywords',
    );
  });
});
