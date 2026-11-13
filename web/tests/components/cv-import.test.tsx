// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CvImport } from '@/components/settings/cv-import';
import type { TaskView } from '@/lib/tasks';
import type { ImportDraft } from '../../../src/cv/import.ts';

vi.mock('@/app/settings/actions', () => ({ importCv: vi.fn(), applyCvImport: vi.fn(), discardCvImport: vi.fn() }));
vi.mock('@/app/actions', () => ({ dismissTask: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const draft: ImportDraft = {
  source: 'jane.pdf',
  created_at: '2026-11-13T10:00:00.000Z',
  cv: {
    name: 'Jane Example',
    title: 'Backend Engineer',
    contact: { phone: '', email: 'jane@example.com', location: 'Lisbon', linkedin: '' },
    summary: '',
    skills: [{ group: 'Languages', items: ['PHP', 'Go'] }],
    experience: [{ role: 'Engineer', company: 'Example Travel', location: '', dates: '2022 — Present', tags: [], bullets: ['Built it.'] }],
    projects: [],
    education: [],
  },
  dropped: ['Kubernetes'],
  warnings: ['The school "Other College" is not in the CV text.'],
};
const task = (status: TaskView['status']): TaskView => ({
  id: 1,
  kind: 'cv_import',
  job_id: null,
  status,
  error: null,
  created_at: new Date(),
  started_at: null,
  finished_at: null,
  company: null,
  title: null,
});

describe('CvImport', () => {
  it('offers the upload, with the accepted file types, and no draft yet', () => {
    render(<CvImport draft={null} error={null} tasks={[]} />);
    const panel = screen.getByRole('region', { name: 'Import your CV' });
    expect(within(panel).getByLabelText('CV file')).toHaveAttribute('accept', '.pdf,.docx,.txt,.md');
    expect(within(panel).getByRole('button', { name: 'Import CV' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Use this as my CV' })).toBeNull();
  });

  it('shows the draft with what was left out and what to check, and the buttons to use or discard it', () => {
    render(<CvImport draft={draft} error={null} tasks={[]} />);
    const panel = screen.getByRole('region', { name: 'Import your CV' });
    expect(panel).toHaveTextContent('Draft from jane.pdf: Jane Example, Backend Engineer');
    expect(panel).toHaveTextContent('1 job, 2 skills, 0 projects, 0 education');
    expect(panel).toHaveTextContent('Left out (not in your file): Kubernetes');
    expect(within(panel).getByRole('listitem')).toHaveTextContent('Other College');
    expect(within(panel).getByRole('button', { name: 'Use this as my CV' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  });

  it('hides the upload while an import runs, and shows a draft that cannot be read as an error', () => {
    render(<CvImport draft={null} error="The imported draft is not a valid CV. Import the CV again." tasks={[task('running')]} />);
    const panel = screen.getByRole('region', { name: 'Import your CV' });
    expect(within(panel).getByRole('status')).toHaveTextContent('Importing your CV');
    expect(within(panel).queryByRole('button', { name: 'Import CV' })).toBeNull();
    expect(within(panel).getByRole('alert')).toHaveTextContent('not a valid CV');
  });
});
