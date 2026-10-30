// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { pool } from '@/lib/db';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

vi.mock('@/app/actions', () => ({
  writeLetter: vi.fn(),
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
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<object>()), runBot: vi.fn(async () => 'Not found') })); // the CV keyword check (ats-check.test.tsx)

/**
 * The page is a sync shell with the async JobDetail server component inside <Suspense>. Pull that element out,
 * await it like the server would, and render its output (client components included) in jsdom.
 */
async function renderJob(id: string) {
  const shell = Page({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof Page>[0]) as ReactElement<{
    children: ReactNode;
  }>;
  const suspense = (shell.props.children as ReactNode[]).find(
    (c): c is ReactElement<{ children: ReactElement }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined,
  )!;
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
    await insertJob({
      id,
      title: 'Senior Laravel Developer',
      company: 'Acme',
      country: 'AE',
      location: 'Dubai',
      status: 'applied',
      score: 70,
      ai_score: 81,
      url: 'https://boards.greenhouse.io/acme/1',
    });
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

  it('shows contacts, people known at the same company, the referral reminder and the skip reason', async () => {
    await insertJob({ id, company: 'Acme Inc.', status: 'new' });
    const other = await insertJob({ id: 'page-other', company: 'ACME', title: 'Frontend Engineer', url: 'https://example.com/o' });
    await pool.query(
      `INSERT INTO contacts (job_id, name, role, referral_status) VALUES ($1, 'Jane', 'recruiter', 'asked'),
      ($2, 'Sam', 'referral', 'to ask')`,
      [id, other],
    );
    await pool.query(`INSERT INTO job_events (job_id, from_status, to_status, reason) VALUES ($1, 'new', 'skipped', 'stack')`, [id]);

    await renderJob(id);
    const contacts = screen.getByRole('heading', { name: /^Contacts/ }).closest('section')!;
    expect(within(contacts).getByText('Jane').closest('li')).toHaveTextContent('referral: asked');
    expect(contacts).toHaveTextContent('You know someone at Acme Inc.');
    expect(screen.getByText(/for a referral before applying/)).toHaveTextContent(
      'Ask Sam for a referral before applying (you added them on Frontend Engineer).',
    );
    expect(screen.getByRole('heading', { name: 'History' }).closest('section')).toHaveTextContent('new → skipped · Stack');
  });

  it('shows only the draft form when there are no answers yet', async () => {
    await insertJob({ id });
    await renderJob(id);
    const section = answersSection();
    expect(within(section).queryByRole('listitem')).not.toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    expect(within(section).queryByText(/Yellow answers need your input/)).not.toBeInTheDocument();

    const textarea = within(section).getByRole('textbox', { name: 'Application form questions' });
    expect(textarea).toHaveAttribute('name', 'questions');
    expect(textarea).toBeRequired();
    const draftForm = textarea.closest('form')!;
    expect(draftForm.querySelector('input[name="id"]')).toHaveValue(id);
    expect(within(draftForm).getByRole('button', { name: 'Draft answers' })).toBeInTheDocument();
  });

  it('labels the job notes field (apart from contact notes) and fills it with the saved notes', async () => {
    await insertJob({ id, notes: 'Recruiter: Sara' });
    await renderJob(id);
    const notes = screen.getByRole('textbox', { name: 'Job notes' });
    expect(notes).toHaveAttribute('name', 'notes');
    expect(notes).toHaveValue('Recruiter: Sara');
    expect(within(notes.closest('form')!).getByRole('button', { name: 'Save notes' })).toBeInTheDocument();
  });

  it('lists drafted answers with copy buttons, highlights ones needing input, and offers Clear all', async () => {
    await insertJob({
      id,
      form_answers: [
        { question: 'Why us?', answer: 'Because of the product.', needs_input: false, note: '' },
        { question: 'Expected salary?', answer: '[your expected salary]', needs_input: true, note: 'Add salary to applicant.json' },
      ],
    });
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

  describe('background tasks', () => {
    const addTask = (kind: string, status = 'running', error: string | null = null) =>
      pool.query(`INSERT INTO tasks (kind, job_id, status, error, deadline) VALUES ($1, $2, $3, $4, now() + interval '5 minutes')`, [
        kind,
        id,
        status,
        error,
      ]);
    const statuses = () => screen.queryAllByRole('status').map((s) => s.textContent);

    it('shows "Preparing CV…" and "Drafting answers…" in place of the buttons while they run', async () => {
      await insertJob({ id });
      await addTask('prepare');
      await addTask('answers', 'queued');
      await renderJob(id);
      expect(statuses()).toEqual(['Working… Preparing CV · Drafting answers', 'Preparing CV…', 'Drafting answers…']);
      expect(screen.queryByRole('button', { name: 'Prepare CV' })).not.toBeInTheDocument();
      expect(within(answersSection()).queryByRole('button', { name: 'Draft answers' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'AI review' })).toBeInTheDocument();
    });

    it('shows "Rewriting letter…" while a letter task runs for a job that has one', async () => {
      await insertJob({ id, cv_version: 'default', cover_letter: 'Dear Acme' });
      await addTask('letter');
      await renderJob(id);
      expect(screen.queryByRole('button', { name: 'Rewrite letter' })).not.toBeInTheDocument();
      expect(statuses()).toContain('Rewriting letter…');
    });

    it('offers "Write letter" before any letter exists, and "Rewrite letter" after; the letter is only shown once written', async () => {
      await insertJob({ id, cv_version: 'default' });
      await renderJob(id);
      const section = screen.getByRole('heading', { name: /^Cover letter/ }).closest('section')!;
      expect(section).toHaveTextContent('not written yet');
      expect(within(section).getByRole('button', { name: 'Write letter' })).toBeInTheDocument();
      expect(within(section).queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument();

      await cleanupDb();
      document.body.innerHTML = '';
      await insertJob({ id, cv_version: 'default', cover_letter: 'Dear Acme', cover_letter_ai: true });
      await renderJob(id);
      const again = screen.getByRole('heading', { name: /^Cover letter/ }).closest('section')!;
      expect(within(again).getByRole('button', { name: 'Rewrite letter' })).toBeInTheDocument();
      expect(again).toHaveTextContent('Dear Acme');
      expect(within(again).getByRole('link', { name: 'Download PDF ↓' })).toHaveAttribute('href', `/api/letter/${encodeURIComponent(id)}`);
      expect(within(section).queryByRole('link', { name: 'Download PDF ↓' })).toBeNull(); // none before a letter exists
    });

    it('shows "Writing letter…" while the first letter is written', async () => {
      await insertJob({ id, cv_version: 'default' });
      await addTask('letter');
      await renderJob(id);
      expect(statuses()).toContain('Writing letter…');
      expect(screen.queryByRole('button', { name: 'Write letter' })).not.toBeInTheDocument();
    });

    it("shows the buttons again once the task is done, and only this job's tasks", async () => {
      await insertJob({ id });
      await insertJob({ id: 'page-other' });
      await addTask('prepare', 'done');
      await pool.query(`INSERT INTO tasks (kind, job_id) VALUES ('answers', $1), ('fetch', NULL)`, [PREFIX + 'page-other']);
      await renderJob(id);
      expect(statuses()).toEqual([]);
      expect(screen.getByRole('button', { name: 'Prepare CV' })).toBeInTheDocument();
      expect(within(answersSection()).getByRole('button', { name: 'Draft answers' })).toBeInTheDocument();
    });

    it('shows a failure with its error and a dismiss button', async () => {
      await insertJob({ id });
      await addTask('answers', 'failed', 'Claude is offline');
      await renderJob(id);
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent(/^Drafting answers failed\s*Claude is offline\s*Dismiss$/);
      expect(within(answersSection()).getByRole('button', { name: 'Draft answers' })).toBeInTheDocument();
    });
  });
});
