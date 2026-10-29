// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('@/app/actions', () => ({
  setStatus: vi.fn(), prepare: vi.fn(), aiReview: vi.fn(), saveNotes: vi.fn(), draftAnswers: vi.fn(), clearAnswers: vi.fn(),
}));
vi.mock('@/app/jobs/[id]/interview-actions', () => ({ prepareInterview: vi.fn() }));

/** Renders the async JobDetail inside the page's <Suspense>, like tests/app/jobs/page.test.tsx. */
async function renderJob(id: string) {
  const shell = Page({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof Page>[0]) as ReactElement<{ children: ReactNode }>;
  const suspense = (shell.props.children as ReactNode[]).find(
    (c): c is ReactElement<{ children: ReactElement }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined)!;
  const detail = suspense.props.children as ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
  return render(<>{await detail.type(detail.props)}</>);
}

const id = PREFIX + 'page-interview';
const prepHeading = () => screen.queryByRole('heading', { name: /Interview prep/ });

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('job page: interview prep', () => {
  it('shows the stored prep for a job in interview', async () => {
    await insertJob({ id, status: 'interview', interview_prep: {
      technical: [{ question: 'Explain Laravel queues', hint: 'Abyan Capital' }],
      behavioural: [], company: { brief: 'Acme makes payroll software.', verify: [] }, questions_to_ask: [], requirements: [],
    } });
    await renderJob(id);
    const section = prepHeading()!.closest('section')!;
    expect(within(section).getByText('Explain Laravel queues')).toBeInTheDocument();
    expect(within(section).getByText('Acme makes payroll software.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('offers to prepare for an interview job without prep, and hides the section for new jobs', async () => {
    await insertJob({ id, status: 'interview' });
    await renderJob(id);
    expect(within(prepHeading()!.closest('section')!).getByRole('button', { name: 'Prepare for interview' })).toBeInTheDocument();

    await cleanupDb();
    await insertJob({ id, status: 'new' });
    document.body.innerHTML = '';
    await renderJob(id);
    expect(prepHeading()).not.toBeInTheDocument();
  });
});
