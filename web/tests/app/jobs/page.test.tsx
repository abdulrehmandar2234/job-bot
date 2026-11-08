// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { pool } from '@/lib/db';
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
  addSkillsToCv: vi.fn(),
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
// History folds away in the sidebar behind "History · n changes".
const history = () => screen.getByRole('heading', { name: /^History/ }).closest('details')!;

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
    expect(history()).toHaveTextContent('new → applied (via site)');
    expect(screen.getByRole('heading', { name: /^History/ })).toHaveTextContent('History · 1 change');
    expect(history()).not.toHaveAttribute('open');
  });

  it('shows the CV panel with the template select, previews, feedback and suggestions, and hides it while a CV task runs', async () => {
    await insertJob({ id, status: 'prepared', cv_version: 'default', cv_review: '- Lead with Laravel.' });
    await renderJob(id);
    const panel = screen.getByRole('region', { name: /CV for this job/ });
    expect(panel).toHaveTextContent('· default · Classic template');
    expect(within(panel).getByLabelText('Template')).toHaveValue('classic');
    expect(within(panel).getByRole('button', { name: 'Apply template' })).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'Modern' })).toHaveAttribute('href', '/api/cv/preview/modern');
    expect(within(panel).getByRole('link', { name: /Download CV/ })).toHaveAttribute('href', '/api/cv/default?download');
    expect(within(panel).getByLabelText(/What should change in this CV\?/)).toBeInTheDocument();
    expect(within(panel).getByText('- Lead with Laravel.')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Suggest again' })).toBeInTheDocument();

    cleanup();
    await pool.query(`INSERT INTO tasks (kind, job_id, status) VALUES ('cv_feedback', $1, 'running')`, [id]);
    await renderJob(id);
    const busy = screen.getByRole('region', { name: /CV for this job/ });
    expect(within(busy).getByText('Improving CV with your feedback…')).toBeInTheDocument();
    expect(within(busy).queryByRole('button', { name: 'Apply template' })).toBeNull();
    expect(within(busy).queryByLabelText(/What should change in this CV\?/)).toBeNull();
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
    expect(history()).toHaveTextContent('new → skipped · Stack');
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

  describe('layout', () => {
    const aside = () => screen.getByRole('complementary', { name: 'Job summary and actions' });

    it('puts the application work in <main> and the summary, actions, contacts and notes in the sidebar', async () => {
      await insertJob({ id, status: 'new', cover_letter: 'Dear Acme', cover_letter_ai: true, cluster: 'laravel' });
      await pool.query(`INSERT INTO job_events (job_id, from_status, to_status) VALUES ($1, NULL, 'new')`, [id]);
      await renderJob(id);
      const main = screen.getByRole('main');
      for (const name of [/^Cover letter/, /^CV summary for this job/, /^Application form answers/, 'Job description'])
        expect(within(main).getByRole('heading', { name })).toBeInTheDocument();

      const side = aside();
      expect(within(side).getByRole('link', { name: 'Open job ↗' })).toHaveAttribute('href', `https://example.com/${id}`);
      for (const name of ['Prepare CV', 'Mark applied ✓', 'Skip', 'AI review', 'Check if still open', 'Save notes'])
        expect(within(side).getByRole('button', { name })).toBeInTheDocument();
      for (const name of [/^Contacts/, /^History/, /^CV ·/]) expect(within(side).getByRole('heading', { name })).toBeInTheDocument();
      expect(within(side).getByRole('textbox', { name: 'Job notes' })).toBeInTheDocument();
      expect(within(main).getByText(/CV keyword/)).toBeInTheDocument(); // the keyword check (or its loading line)
      expect(within(main).queryByRole('button', { name: 'Prepare CV' })).toBeNull();
      expect(within(side).queryByRole('heading', { name: /^Cover letter/ })).toBeNull();
      // The page's own heading comes before both columns, and the status is shown once.
      expect(screen.getByRole('heading', { level: 1 }).compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByText(/Status:/)).toHaveLength(1);
      expect(within(side).getByText(/Status:/)).toHaveTextContent('Status: Matching');
    });

    it('keeps the CV download in its own named sidebar block, apart from the other actions', async () => {
      await insertJob({ id, status: 'prepared', cv_version: 'laravel-v2', cluster: 'laravel' });
      await renderJob(id);
      const cv = within(aside()).getByRole('region', { name: /^CV/ });
      expect(cv).toHaveAttribute('id', 'cv');
      expect(cv).toHaveTextContent('suggested version: laravel');
      expect(within(cv).getByRole('link', { name: 'Download CV (laravel-v2) ↓' })).toHaveAttribute('href', '/api/cv/laravel-v2?download');
      expect(within(cv).queryByRole('button', { name: 'Mark applied ✓' })).toBeNull();
    });

    it('shows the job facts in the summary card: score, salary, visa label and posted date', async () => {
      await insertJob({
        id,
        score: 64,
        ai_score: 82,
        ai_verdict: 'strong',
        salary_min: 20_000,
        salary_max: 25_000,
        salary_currency: 'AED',
        salary_period: 'month',
        visa: 'Visa sponsorship mentioned',
        visa_evidence: 'offered',
        posted_at: new Date(),
      });
      await renderJob(id);
      const card = within(aside()).getByRole('region', { name: 'Job summary' });
      expect(card).toHaveTextContent('AI score 82 · keyword score 64');
      expect(card).toHaveTextContent('💰 AED 20k–25k / month');
      expect(card).toHaveTextContent('✓ Visa/relocation offered · Visa sponsorship mentioned');
      expect(card).toHaveTextContent(/posted <24h ago/);
    });

    it('links to each section of the main column, and to interview prep only when it is shown', async () => {
      await insertJob({ id, status: 'new' });
      await renderJob(id);
      const nav = screen.getByRole('navigation', { name: 'Sections on this page' });
      const links = within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]);
      expect(links).toEqual([
        ['Cover letter', '#letter'],
        ['CV summary', '#cv-summary'],
        ['CV template', '#cv-panel'],
        ['Form answers', '#answers'],
        ['Job description', '#description'],
      ]);
      for (const [, href] of links) expect(document.getElementById(href!.slice(1))).not.toBeNull();

      await cleanupDb();
      document.body.innerHTML = '';
      await insertJob({ id, status: 'interview' });
      await renderJob(id);
      const prep = within(screen.getByRole('navigation', { name: 'Sections on this page' })).getByRole('link', { name: 'Interview prep' });
      expect(document.getElementById('prep')).toContainElement(screen.getByRole('heading', { name: /^Interview prep/ }));
      expect(prep).toHaveAttribute('href', '#prep');
    });
  });

  describe('folded sections', () => {
    const long = `First line of the job.\n${'We build payroll software for the Gulf. '.repeat(30)}\nLast line of the job.`;

    it('shows the first lines of a long description and folds the rest behind "Show full description"', async () => {
      await insertJob({ id, description: long });
      await renderJob(id);
      const section = screen.getByRole('heading', { name: 'Job description' }).closest('section')!;
      const toggle = within(section).getByText('Show full description');
      const details = toggle.closest('details')!;
      expect(details).not.toHaveAttribute('open');
      expect(details).toHaveTextContent('Last line of the job.');
      // The preview is the visible part while folded.
      const preview = section.querySelector('p.line-clamp-4')!;
      expect(preview).toHaveTextContent(/^First line of the job\./);
      expect(details).not.toContainElement(preview as HTMLElement);
    });

    it('shows a short description in full with no toggle', async () => {
      await insertJob({ id, description: 'Short and sweet.' });
      await renderJob(id);
      const section = screen.getByRole('heading', { name: 'Job description' }).closest('section')!;
      expect(section).toHaveTextContent('Short and sweet.');
      expect(within(section).queryByText(/Show full description/)).toBeNull();
      expect(section.querySelector('details')).toBeNull();
    });

    it('keeps the AI verdict and summary visible and folds the reasons, gaps and flags', async () => {
      await insertJob({
        id,
        ai_score: 80,
        ai_verdict: 'strong',
        ai_summary: 'Good Laravel fit.',
        ai_reasons: ['Laravel'],
        ai_gaps: ['Kafka'],
        ai_flags: [],
      });
      await renderJob(id);
      const heading = screen.getByRole('heading', { name: /^AI review/ });
      expect(heading).toHaveTextContent('AI review · strong');
      const summary = heading.closest('summary')!;
      expect(summary).toHaveTextContent('Good Laravel fit.');
      const details = summary.closest('details')!;
      expect(details).not.toHaveAttribute('open');
      expect(details).toHaveTextContent('✓ Laravel');
      expect(summary).not.toHaveTextContent('✓ Laravel');
    });

    it('folds the skills match behind its counts, with a filter reason left visible', async () => {
      await insertJob({ id, matched: ['Laravel', 'PHP'], missing: ['Go'], flags: [], filter_reason: 'needs Arabic' });
      await renderJob(id);
      const heading = screen.getByRole('heading', { name: /^Skills match/ });
      expect(heading).toHaveTextContent('Skills match · 2 you have · 1 missing');
      expect(heading.closest('summary')).toHaveTextContent('✗ Filtered: needs Arabic');
      expect(heading.closest('details')).not.toHaveAttribute('open');
    });

    it('keeps the letter state, Copy and Download PDF visible, and folds the letter text with its editor', async () => {
      await insertJob({ id, cover_letter: 'Dear Acme,\nI am writing to apply.', cover_letter_ai: true });
      await renderJob(id);
      const section = screen.getByRole('heading', { name: /^Cover letter/ }).closest('section')!;
      const details = within(section).getByText('Show full letter').closest('details')!;
      expect(details).not.toHaveAttribute('open');
      for (const name of ['Edit', 'Rewrite with feedback']) expect(within(details).getByRole('button', { name })).toBeInTheDocument();
      const download = within(section).getByRole('link', { name: 'Download PDF ↓' });
      expect(details).not.toContainElement(download);
      expect(details).not.toContainElement(within(section).getByRole('button', { name: 'Copy' }));
      expect(within(section).getByRole('heading')).toHaveTextContent('· written by AI from this job description');
    });
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

    const letterSection = () => screen.getByRole('heading', { name: /^Cover letter/ }).closest('section')!;
    const summarySection = () => screen.getByRole('heading', { name: /^CV summary for this job/ }).closest('section')!;

    it('labels a letter the user edited "edited by you", and offers Edit and feedback once a letter exists', async () => {
      await insertJob({ id, cover_letter: 'Dear Acme, mine', cover_letter_ai: false, cover_letter_edited_at: new Date() });
      await renderJob(id);
      const s = letterSection();
      expect(within(s).getByRole('heading')).toHaveTextContent('· edited by you');
      for (const name of ['Rewrite letter', 'Copy', 'Edit', 'Rewrite with feedback'])
        expect(within(s).getByRole('button', { name })).toBeInTheDocument();
      expect(within(s).getByRole('link', { name: 'Download PDF ↓' })).toBeInTheDocument();
      expect(within(s).getByLabelText(/What should change\?/)).toHaveAttribute('maxlength', '1000');
    });

    it('labels a template letter "template", and offers no Edit or feedback before a letter exists', async () => {
      await insertJob({ id, cover_letter: 'Dear Acme', cover_letter_ai: false });
      await renderJob(id);
      expect(within(letterSection()).getByRole('heading')).toHaveTextContent('· template');
      await cleanupDb();
      document.body.innerHTML = '';
      await insertJob({ id });
      await renderJob(id);
      expect(within(letterSection()).queryByRole('button', { name: 'Edit' })).toBeNull();
      expect(within(letterSection()).queryByRole('button', { name: 'Rewrite with feedback' })).toBeNull();
    });

    it("says why a template letter is not the AI's when the AI failed, and not once the letter is edited", async () => {
      const why = 'DeepSeek rejected the API key (AI_API_KEY): 401.';
      await insertJob({ id, cover_letter: 'Dear Acme', cover_letter_ai: false, cover_letter_ai_error: why });
      await renderJob(id);
      expect(within(letterSection()).getByRole('note')).toHaveTextContent(
        `The AI could not write this letter, so this is the template letter. ${why}`,
      );
      await cleanupDb();
      document.body.innerHTML = '';
      await insertJob({
        id,
        cover_letter: 'Dear Acme, mine',
        cover_letter_ai: false,
        cover_letter_ai_error: why,
        cover_letter_edited_at: new Date(),
      });
      await renderJob(id);
      expect(within(letterSection()).queryByRole('note')).toBeNull();
    });

    it('hides Edit and feedback while the letter is rewritten', async () => {
      await insertJob({ id, cover_letter: 'Dear Acme', cover_letter_ai: true });
      await addTask('letter');
      await renderJob(id);
      const s = letterSection();
      expect(within(s).getByRole('status')).toHaveTextContent('Rewriting letter…');
      expect(s).toHaveTextContent('Dear Acme');
      for (const name of ['Rewrite letter', 'Edit', 'Rewrite with feedback']) expect(within(s).queryByRole('button', { name })).toBeNull();
    });

    it('CV summary: "not written yet" and Write summary before one exists', async () => {
      await insertJob({ id });
      await renderJob(id);
      const s = summarySection();
      expect(within(s).getByRole('heading')).toHaveTextContent('· not written yet');
      expect(within(s).getByRole('button', { name: 'Write summary' })).toBeInTheDocument();
      for (const name of ['Copy', 'Use in my CV for this job', 'Edit', 'Rewrite with feedback'])
        expect(within(s).queryByRole('button', { name })).toBeNull();
    });

    it('CV summary: Rewrite, Copy, Use in my CV, Edit and feedback once one exists', async () => {
      await insertJob({ id, cv_summary: 'Senior engineer with Laravel.' });
      await renderJob(id);
      const s = summarySection();
      expect(within(s).getByRole('heading')).toHaveTextContent('· written by AI for this job');
      expect(s).toHaveTextContent('Senior engineer with Laravel.');
      for (const name of ['Rewrite summary', 'Copy', 'Use in my CV for this job', 'Edit', 'Rewrite with feedback'])
        expect(within(s).getByRole('button', { name })).toBeInTheDocument();
    });

    it('CV summary: "edited by you" after a hand edit', async () => {
      await insertJob({ id, cv_summary: 'Mine.', cv_summary_edited_at: new Date() });
      await renderJob(id);
      expect(within(summarySection()).getByRole('heading')).toHaveTextContent('· edited by you');
    });

    it.each([
      ['summary', null, 'Writing summary…', ['Write summary']],
      ['summary', 'Old.', 'Rewriting summary…', ['Rewrite summary', 'Use in my CV for this job', 'Edit', 'Rewrite with feedback']],
      ['tailored_cv', 'Old.', 'Building CV with this summary…', ['Use in my CV for this job', 'Edit', 'Rewrite with feedback']],
    ] as const)('CV summary: a running %s task (summary %j) shows %j in place of the buttons', async (kind, cv_summary, busy, hidden) => {
      await insertJob({ id, cv_summary });
      await addTask(kind);
      await renderJob(id);
      const s = summarySection();
      expect(within(s).getByRole('status')).toHaveTextContent(busy);
      for (const name of hidden) expect(within(s).queryByRole('button', { name })).toBeNull();
      expect(statuses()[0]).toMatch(kind === 'summary' ? /Writing CV summary/ : /Building CV with summary/);
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
