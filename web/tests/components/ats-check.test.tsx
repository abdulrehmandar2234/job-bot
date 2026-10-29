// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AtsCheck, AtsLists, type AtsReport } from '@/components/ats-check';
import { runBot } from '@/lib/bot';

vi.mock('@/lib/bot', () => ({ runBot: vi.fn() }));

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
    expect(screen.getByText(/real gaps, do not add them/).parentElement).toHaveTextContent('Kubernetes');
    expect(screen.getByText(/version shows 4 of them/)).toHaveTextContent('The backend-node version shows 4 of them (adds Docker, AWS).');
  });

  it('leaves out empty lists and the suggestion when there is none', () => {
    render(<AtsLists report={report({ hiddenButTrue: [], missing: [], total: 2, suggestion: null })} />);
    expect(screen.queryByText(/not near the top/)).not.toBeInTheDocument();
    expect(screen.queryByText(/real gaps/)).not.toBeInTheDocument();
    expect(screen.queryByText(/💡/)).not.toBeInTheDocument();
  });

  it('never offers a missing keyword in the suggestion', () => {
    render(<AtsLists report={report()} />);
    expect(screen.getByText(/version shows 4 of them/)).not.toHaveTextContent('Kubernetes');
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
