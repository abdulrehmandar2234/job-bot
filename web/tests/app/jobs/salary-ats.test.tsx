// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { runBot } from '@/lib/bot';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('@/app/actions', () => ({
  writeLetter: vi.fn(),
  rewriteLetter: vi.fn(),
  saveLetter: vi.fn(),
  writeSummary: vi.fn(),
  rewriteSummary: vi.fn(),
  saveSummary: vi.fn(),
  tailorCv: vi.fn(),
  applyCvTemplate: vi.fn(),
  improveCv: vi.fn(),
  reviewCv: vi.fn(),
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

/** The <AtsCheck> element, wherever the layout nests it among the page's own elements. */
function findAts(node: ReactNode): ReactElement<{ jobId: string }> | undefined {
  if (Array.isArray(node)) {
    for (const c of node) {
      const hit = findAts(c);
      if (hit) return hit;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const props = node.props as { jobId?: string; children?: ReactNode };
  if (props.jobId !== undefined) return node as ReactElement<{ jobId: string }>;
  return typeof node.type === 'string' ? findAts(props.children) : undefined;
}

/** Renders the job detail, and the CV keyword check inside it, after awaiting both like the server would. */
async function renderJob(id: string) {
  const shell = Page({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof Page>[0]) as ReactElement<{
    children: ReactNode;
  }>;
  const detail = suspenseChild(shell.props.children);
  const rendered = (await detail.type(detail.props)) as ReactElement<{ children: ReactNode }>;
  const ats = findAts(rendered)!;
  const loader = suspenseChild((ats.type as (p: unknown) => ReactNode)(ats.props));
  render(
    <>
      {rendered}
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
    const heading = screen.getAllByRole('heading', { name: /CV keyword check/ }).at(-1)!;
    expect(heading).toHaveTextContent('laravel (suggested) shows 1 of 3 job keywords');
    // Folded behind that count.
    const details = heading.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(details).toHaveTextContent('Kafka');
  });
});
