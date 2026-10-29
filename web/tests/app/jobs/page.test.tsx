// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('@/app/actions', () => ({
  setStatus: vi.fn(), prepare: vi.fn(), aiReview: vi.fn(), saveNotes: vi.fn(), draftAnswers: vi.fn(), clearAnswers: vi.fn(),
}));

/**
 * The page is a sync shell with the async JobDetail server component inside <Suspense>. Pull that element out,
 * await it like the server would, and render its output (client components included) in jsdom.
 */
async function renderJob(id: string) {
  const shell = Page({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof Page>[0]) as ReactElement<{ children: ReactNode }>;
  const suspense = (shell.props.children as ReactNode[]).find(
    (c): c is ReactElement<{ children: ReactElement }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined)!;
  const detail = suspense.props.children as ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
  return render(<>{await detail.type(detail.props)}</>);
}

const answersSection = () => screen.getByRole('heading', { name: /Application form answers/ }).closest('section')!;

const id = PREFIX + 'page';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterAll(closeDb);

describe('job page', () => {
  it('404s for an unknown job', async () => {
    await expect(renderJob(PREFIX + 'missing')).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
  });

  it('shows the job header, postings on other sites and history', async () => {
    await insertJob({ id, title: 'Senior Laravel Developer', company: 'Acme', country: 'AE', location: 'Dubai',
      status: 'applied', score: 70, ai_score: 81, url: 'https://boards.greenhouse.io/acme/1' });
    await insertJob({ id: 'page-li', source: 'linkedin', url: 'https://linkedin.com/jobs/1', duplicate_of: id });
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status, note) VALUES ($1, 'new', 'applied', 'via site')`, [id]);

    await renderJob(id);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Senior Laravel Developer');
    expect(screen.getByText(/Acme · 🇦🇪 UAE · Dubai/)).toBeInTheDocument();
    expect(screen.getByText('Applied')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Company site ↗' })).toHaveAttribute('href', 'https://boards.greenhouse.io/acme/1');
    expect(screen.getByRole('link', { name: 'LinkedIn ↗' })).toHaveAttribute('href', 'https://linkedin.com/jobs/1');
    expect(screen.getByRole('button', { name: 'Got interview' })).toBeInTheDocument();
    const history = screen.getByRole('heading', { name: 'History' }).closest('section')!;
    expect(history).toHaveTextContent('new → applied (via site)');
  });

  it('shows only the draft form when there are no answers yet', async () => {
    await insertJob({ id });
    await renderJob(id);
    const section = answersSection();
    expect(within(section).queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    expect(within(section).queryByText(/Yellow answers need your input/)).not.toBeInTheDocument();

    const textarea = within(section).getByRole('textbox');
    expect(textarea).toHaveAttribute('name', 'questions');
    expect(textarea).toBeRequired();
    const draftForm = textarea.closest('form')!;
    expect(draftForm.querySelector('input[name="id"]')).toHaveValue(id);
    expect(within(draftForm).getByRole('button', { name: 'Draft answers' })).toBeInTheDocument();
  });

  it('lists drafted answers with copy buttons, highlights ones needing input, and offers Clear all', async () => {
    await insertJob({ id, form_answers: [
      { question: 'Why us?', answer: 'Because of the product.', needs_input: false, note: '' },
      { question: 'Expected salary?', answer: '[your expected salary]', needs_input: true, note: 'Add salary to applicant.json' },
    ] });
    await renderJob(id);
    const section = answersSection();
    const items = within(section).getAllByRole('listitem');
    expect(items).toHaveLength(2);

    expect(items[0]).toHaveTextContent('Why us?');
    expect(items[0]).toHaveTextContent('Because of the product.');
    expect(items[0]).not.toHaveClass('border-amber-300');
    expect(within(items[0]).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(within(items[0]).queryByText(/💡/)).not.toBeInTheDocument();

    expect(items[1]).toHaveClass('border-amber-300');
    expect(items[1]).toHaveTextContent('💡 Add salary to applicant.json');

    expect(within(section).getByText(/Yellow answers need your input/)).toBeInTheDocument();
    const clear = within(section).getByRole('button', { name: 'Clear all' });
    expect(clear.closest('form')!.querySelector('input[name="id"]')).toHaveValue(id);
  });

  it('decodes an encoded id from the URL', async () => {
    await insertJob({ id: 'page:with/slash', title: 'Encoded' });
    await renderJob(PREFIX + 'page:with/slash');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Encoded');
  });
});
