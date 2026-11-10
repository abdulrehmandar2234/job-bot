// @vitest-environment jsdom
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render, screen, within } from '@testing-library/react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from '@/app/jobs/[id]/page';
import { StatusActions } from '@/components/job-actions';
import type { Job } from '@/lib/db';
import { aiEnabled } from '@/lib/settings';
import { cleanupDb, closeDb, ensureSchema, insertJob, PREFIX } from '../../helpers/db';

// config.json `ai.enabled: false`: the job page hides every AI-only button and says why, with a link to Settings.
// "Write letter" and "Draft follow-up" stay, because the bot falls back to its templates for them.

vi.mock('@/app/actions', () => ({
  writeLetter: vi.fn(),
  rewriteLetter: vi.fn(),
  saveLetter: vi.fn(),
  writeSummary: vi.fn(),
  writeHeadline: vi.fn(),
  rewriteHeadline: vi.fn(),
  saveHeadline: vi.fn(),
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
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: vi.fn() }),
}));
vi.mock('@/lib/bot', async (orig) => ({ ...(await orig<object>()), runBot: vi.fn(async () => 'Not found') }));

/** As in page.test.tsx: await the async JobDetail inside <Suspense> and render its output. */
async function renderJob(id: string) {
  const shell = Page({ params: Promise.resolve({ id: encodeURIComponent(id) }) } as Parameters<typeof Page>[0]) as ReactElement<{
    children: ReactNode;
  }>;
  const suspense = ([] as ReactNode[])
    .concat(shell.props.children)
    .find(
      (c): c is ReactElement<{ children: ReactElement }> => isValidElement(c) && (c.props as { fallback?: unknown }).fallback !== undefined,
    )!;
  const detail = suspense.props.children as ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
  return render(<>{await detail.type(detail.props)}</>);
}

const dir = mkdtempSync(join(tmpdir(), 'job-bot-ai-off-'));
const configWith = (cfg: unknown) => {
  const file = join(dir, `config-${Math.random()}.json`);
  writeFileSync(file, JSON.stringify(cfg));
  vi.stubEnv('JOB_BOT_CONFIG', file);
};
const section = (heading: RegExp) => screen.getByRole('heading', { name: heading }).closest('section')!;
const id = PREFIX + 'ai-off';

beforeAll(ensureSchema);
beforeEach(cleanupDb);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closeDb();
});

describe('aiEnabled', () => {
  it('is false only for an explicit ai.enabled false', () => {
    configWith({ ai: { enabled: false } });
    expect(aiEnabled()).toBe(false);
    configWith({ ai: { enabled: true } });
    expect(aiEnabled()).toBe(true);
    configWith({ countries: {} });
    expect(aiEnabled()).toBe(true);
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'missing.json'));
    expect(aiEnabled()).toBe(true);
  });
});

describe('StatusActions (job cards)', () => {
  it('hides "AI review" when ai is false', () => {
    const job = { id: 'x', status: 'new', ai_score: null } as unknown as Job;
    const { unmount } = render(<StatusActions job={job} />);
    expect(screen.getByRole('button', { name: 'AI review' })).toBeInTheDocument();
    unmount();
    render(<StatusActions job={job} ai={false} />);
    expect(screen.queryByRole('button', { name: 'AI review' })).toBeNull();
  });
});

describe('job page with the AI off', () => {
  it('hides the AI-only buttons, with notes linking to Settings, and keeps the template ones', async () => {
    configWith({ ai: { enabled: false } });
    await insertJob({ id, status: 'applied', cover_letter: 'Dear team', cv_summary: 'React engineer.', cv_version: 'default' });
    await renderJob(id);

    for (const name of ['AI review', 'Write summary', 'Rewrite summary', 'Draft answers', 'Prepare for interview']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: 'Improve CV with feedback' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Suggest improvements|Suggest again/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rewrite with feedback' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Application form questions' })).toBeNull();

    const notes = screen.getAllByRole('note').filter((n) => /^AI is off/.test(n.textContent ?? ''));
    expect(notes.map((n) => n.textContent)).toEqual(
      expect.arrayContaining([
        'AI is off, so the AI review is not available. Turn it on in Settings.',
        'AI is off, so drafting answers is not available. Turn it on in Settings.',
        'AI is off, so interview prep is not available. Turn it on in Settings.',
        'AI is off, so CV feedback (improving the CV and suggestions) is not available. Turn it on in Settings.',
        'AI is off, so rewriting with feedback is not available. Turn it on in Settings.',
      ]),
    );
    for (const n of notes) expect(within(n).getByRole('link', { name: 'Turn it on in Settings' })).toHaveAttribute('href', '/settings');

    // The template fallbacks stay, and so does editing by hand.
    expect(within(section(/^Cover letter/)).getByRole('button', { name: 'Rewrite letter' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draft follow-up' })).toBeInTheDocument();
    expect(within(section(/^CV summary/)).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('says why there is no "Write summary" before a summary exists', async () => {
    configWith({ ai: { enabled: false } });
    await insertJob({ id });
    await renderJob(id);
    expect(within(section(/^CV summary/)).getByRole('note')).toHaveTextContent(
      'AI is off, so writing a CV summary for this job is not available.',
    );
    expect(within(section(/^Cover letter/)).getByRole('button', { name: 'Write letter' })).toBeInTheDocument();
  });

  it('shows every AI button with the AI on', async () => {
    configWith({ ai: { enabled: true } });
    await insertJob({ id, status: 'applied' });
    await renderJob(id);
    for (const name of ['AI review', 'Write summary', 'Draft answers', 'Prepare for interview', 'Suggest improvements']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.queryAllByRole('note').filter((n) => /^AI is off/.test(n.textContent ?? ''))).toEqual([]);
  });
});
