// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { improveCv } from '@/app/actions';
import type { Job } from '@/lib/db';
import { PREFIX } from '../helpers/db';

vi.mock('@/app/actions', () => ({ applyCvTemplate: vi.fn(), improveCv: vi.fn(), reviewCv: vi.fn() }));

// lib/bot.ts resolves BOT_ROOT from the working directory at import time: a temp bot folder with one version and a
// config.json whose default template is compact.
const root = mkdtempSync(join(tmpdir(), 'job-bot-web-cvpanel-'));
let CvPanel: typeof import('@/components/cv-panel').CvPanel;

beforeAll(async () => {
  mkdirSync(join(root, 'cv', 'versions', 'custom-acme-v2'), { recursive: true });
  writeFileSync(join(root, 'cv', 'versions', 'custom-acme-v2', 'meta.json'), JSON.stringify({ id: 'custom-acme-v2', template: 'modern' }));
  mkdirSync(join(root, 'cv', 'versions', 'custom-acme-v3'), { recursive: true });
  writeFileSync(
    join(root, 'cv', 'versions', 'custom-acme-v3', 'meta.json'),
    JSON.stringify({ id: 'custom-acme-v3', template: 'modern', feedbackNote: ['Employer "Google" (not on your master CV)'] }),
  );
  writeFileSync(join(root, 'config.json'), JSON.stringify({ cvTemplate: 'compact' }));
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'web'));
  try {
    ({ CvPanel } = await import('@/components/cv-panel'));
  } finally {
    cwd.mockRestore();
  }
});
beforeEach(() => {
  vi.clearAllMocks();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const job = (o: Partial<Job> = {}) => ({ id: PREFIX + 'panel', cv_version: null, cv_template: null, cv_review: null, ...o }) as Job;
const panel = () => screen.getByRole('region', { name: /CV for this job/ });

describe('CvPanel', () => {
  it('without a CV: the default template is selected and marked, previews for each, no download', () => {
    render(<CvPanel job={job()} />);
    expect(panel()).toHaveTextContent('· not prepared yet');
    const select = screen.getByLabelText('Template');
    expect(select).toHaveValue('compact');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Classic', 'Modern', 'Compact (default)']);
    expect(screen.getByRole('button', { name: 'Apply template' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Classic' })).toHaveAttribute('href', '/api/cv/preview/classic');
    expect(screen.getByRole('link', { name: 'Compact' })).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('link', { name: /Download CV/ })).toBeNull();
    expect(screen.getByText(/The template is used when the CV is prepared/)).toBeInTheDocument();
  });

  it("with a CV: its version and template, the job's own template selected, and Download CV", () => {
    render(<CvPanel job={job({ cv_version: 'custom-acme-v2', cv_template: 'modern' })} />);
    expect(panel()).toHaveTextContent('· custom-acme-v2 · Modern template');
    expect(screen.getByLabelText('Template')).toHaveValue('modern');
    expect(screen.getByRole('link', { name: /Download CV/ })).toHaveAttribute('href', '/api/cv/custom-acme-v2?download');
    expect(screen.getByText(/the CV you may already have sent stays as it is/)).toBeInTheDocument();
  });

  it('while a task changes the CV, hides Apply template, the feedback form and the download', () => {
    const { rerender } = render(<CvPanel job={job({ cv_version: 'default' })} busy={['cv_template']} />);
    expect(screen.getByRole('status')).toHaveTextContent('Applying template…');
    expect(screen.queryByRole('button', { name: 'Apply template' })).toBeNull();
    expect(screen.queryByLabelText(/What should change in this CV/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Download CV/ })).toBeNull();
    rerender(<CvPanel job={job({ cv_version: 'default' })} busy={['cv_feedback']} />);
    expect(screen.getByText('Improving CV with your feedback…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply template' })).toBeNull();
    rerender(<CvPanel job={job({ cv_version: 'default' })} busy={['cv_review']} />);
    expect(screen.getByText('Reviewing CV…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply template' })).toBeInTheDocument();
  });

  it('"Improve CV with feedback" sends the feedback with the job id and shows a refusal', async () => {
    vi.mocked(improveCv).mockResolvedValue({ ok: false, message: 'Write what should change first.' });
    const user = userEvent.setup();
    render(<CvPanel job={job({ cv_version: 'default' })} />);
    const box = screen.getByLabelText(/What should change in this CV\?/);
    expect(box).toHaveAttribute('maxlength', '1000');
    await user.type(box, 'put Laravel experience first');
    await user.click(screen.getByRole('button', { name: 'Improve CV with feedback' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Write what should change first.'));
    const fd = vi.mocked(improveCv).mock.calls.at(-1)![1];
    expect([fd.get('id'), fd.get('feedback')]).toEqual([PREFIX + 'panel', 'put Laravel experience first']);
    expect(box).toHaveValue('put Laravel experience first');
  });

  it('shows the suggestions, and "Use as feedback" copies them into the box', async () => {
    const review = '- Lead with the fintech work.\n- Kubernetes is missing from your CV.';
    const user = userEvent.setup();
    render(<CvPanel job={job({ cv_version: 'default', cv_review: review })} />);
    expect(screen.getByRole('heading', { name: 'Suggestions for this CV' })).toBeInTheDocument();
    expect(screen.getByText(/Lead with the fintech work/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest again' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use as feedback' }));
    expect(screen.getByLabelText(/What should change in this CV\?/)).toHaveValue(review);
  });

  it('offers "Suggest improvements" when there is no review yet', () => {
    render(<CvPanel job={job()} />);
    expect(screen.getByRole('button', { name: 'Suggest improvements' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use as feedback' })).toBeNull();
  });

  it('lists what was left out when the CV was revised with feedback (its meta.json)', () => {
    const { rerender } = render(<CvPanel job={job({ cv_version: 'custom-acme-v3' })} />);
    expect(screen.getByRole('note')).toHaveTextContent('Employer "Google" (not on your master CV)');
    rerender(<CvPanel job={job({ cv_version: 'custom-acme-v2' })} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});
