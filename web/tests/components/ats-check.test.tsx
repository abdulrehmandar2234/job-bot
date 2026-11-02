// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtsCheck, AtsLists, type AtsReport } from '@/components/ats-check';
import { runBot } from '@/lib/bot';

vi.mock('@/lib/bot', () => ({ runBot: vi.fn() }));
vi.mock('@/app/actions', () => ({ addSkillsToCv: vi.fn() }));

const report = (o: Partial<AtsReport> = {}): AtsReport => ({
  label: 'laravel-v2',
  source: 'prepared',
  present: ['Laravel', 'PHP'],
  hiddenButTrue: ['Docker', 'AWS'],
  missing: ['Kubernetes'],
  total: 5,
  suggestion: { version: 'backend-node', shows: 4, gains: ['Docker', 'AWS'] },
  ...o,
});

/** AtsCheck wraps its loader in <Suspense>: await the loader like the server would. */
async function renderCheck(jobId: string) {
  const loader = (
    AtsCheck({ jobId }) as ReactElement<{ children: ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>> }>
  ).props.children;
  return render(<>{await loader.type(loader.props)}</>);
}

beforeEach(() => vi.mocked(runBot).mockReset());

describe('AtsLists', () => {
  it('shows the version, the three lists and the suggestion', () => {
    render(<AtsLists report={report()} />);
    expect(screen.getByRole('heading', { name: /CV keyword check/ })).toHaveTextContent('laravel-v2 (prepared) shows 2 of 5 job keywords');
    expect(screen.getByText('Shown:').parentElement).toHaveTextContent('LaravelPHP');
    expect(screen.getByText(/not near the top of this version/).parentElement).toHaveTextContent('DockerAWS');
    expect(screen.getByText(/add one only if you really have it/).parentElement).toHaveTextContent('Kubernetes');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText(/version shows 4 of them/)).toHaveTextContent('The backend-node version shows 4 of them (adds Docker, AWS).');
  });

  it('leaves out empty lists and the suggestion when there is none', () => {
    render(<AtsLists report={report({ hiddenButTrue: [], missing: [], total: 2, suggestion: null })} />);
    expect(screen.queryByText(/not near the top/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Not on your CV/)).not.toBeInTheDocument();
    expect(screen.queryByText(/💡/)).not.toBeInTheDocument();
  });

  it('folds the lists behind the heading, which keeps the count visible', () => {
    render(<AtsLists report={report()} />);
    const heading = screen.getByRole('heading', { name: /CV keyword check/ });
    const details = heading.closest('details')!;
    expect(details).toHaveAttribute('id', 'ats');
    expect(details).not.toHaveAttribute('open');
    expect(heading.closest('summary')).toHaveTextContent('shows 2 of 5 job keywords · 1 not on your CV');
    expect(heading.closest('summary')).not.toHaveTextContent('Kubernetes');
    expect(details).toHaveTextContent('Kubernetes');
  });

  it('leaves the missing count out of the heading when nothing is missing', () => {
    render(<AtsLists report={report({ missing: [], total: 4 })} />);
    expect(screen.getByRole('heading', { name: /CV keyword check/ })).not.toHaveTextContent('not on your CV');
  });

  it('never offers a missing keyword in the suggestion', () => {
    render(<AtsLists report={report()} />);
    expect(screen.getByText(/version shows 4 of them/)).not.toHaveTextContent('Kubernetes');
  });

  it('offers the missing keywords as "I have this" checkboxes when they can be added', () => {
    render(<AtsLists report={report({ missing: ['Kubernetes', 'Kafka'] })} confirmFor="greenhouse:acme:1" />);
    expect(screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).value)).toEqual(['Kubernetes', 'Kafka']);
    expect(screen.getByRole('button', { name: 'Add to my CV and improve it for this job' })).toBeInTheDocument();
    expect(screen.queryByText(/add one only if you really have it/)).not.toBeInTheDocument();
  });

  it('renders nothing when the job names no known keywords', () => {
    const { container } = render(<AtsLists report={report({ present: [], hiddenButTrue: [], missing: [], total: 0, suggestion: null })} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('AtsCheck', () => {
  it('asks the bot for the report as JSON', async () => {
    vi.mocked(runBot).mockResolvedValue(JSON.stringify(report()));
    await renderCheck('greenhouse:acme:1');
    expect(runBot).toHaveBeenCalledWith(['ats', 'greenhouse:acme:1', '--json']);
    expect(screen.getByRole('heading', { name: /CV keyword check/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows the checkboxes with confirm', async () => {
    vi.mocked(runBot).mockResolvedValue(JSON.stringify(report()));
    const loader = (
      AtsCheck({ jobId: 'greenhouse:acme:1', confirm: true }) as ReactElement<{
        children: ReactElement<Record<string, unknown>, (p: unknown) => Promise<ReactNode>>;
      }>
    ).props.children;
    render(<>{await loader.type(loader.props)}</>);
    expect(screen.getByRole('checkbox', { name: 'Kubernetes' })).toBeInTheDocument();
  });

  it('says it is unavailable when the bot answers something else than a report', async () => {
    vi.mocked(runBot).mockResolvedValue('Not found\n');
    try {
      await renderCheck('x');
    } catch (e) {
      console.log('CAUGHT IN TEST', (e as Error).stack);
      throw e;
    }
    expect(screen.getByText('CV keyword check is not available right now.')).toBeInTheDocument();
  });
});
