// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Triage } from '@/components/triage';
import type { TextFormState } from '@/lib/written-text';

// The keyboard triage layer works on the server-rendered cards: <li data-job-id tabIndex=-1> with the real
// actions marked by data-shortcut (app/page.tsx, components/job-actions.tsx, skip-button.tsx). This harness
// renders the same structure with spies in place of the server-action forms.

const skip = vi.fn<(prev: TextFormState, fd: FormData) => Promise<TextFormState>>();
const acted = vi.fn<(what: string, id: string, reason?: string) => void>();

function Card({ id }: { id: string }) {
  return (
    <li data-job-id={id} tabIndex={-1}>
      <a
        href={`https://jobs.example/${id}`}
        data-shortcut="enter"
        onClick={(e) => {
          e.preventDefault();
          acted('open', id);
        }}
      >
        Open job ↗
      </a>
      <a
        href={`/jobs/${id}`}
        data-shortcut="o"
        onClick={(e) => {
          if (!e.shiftKey) e.preventDefault(); // shift-click: the browser's own (new window), see the shift-click test
          acted('detail', id);
        }}
      >
        {id} title
      </a>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          acted('skip', id, String(new FormData(e.currentTarget).get('reason')));
        }}
      >
        <select name="reason" defaultValue="" data-shortcut="s" aria-label={`Skip reason ${id}`}>
          <option value="">why?</option>
          <option value="seniority">Seniority</option>
        </select>
        <button type="submit">Skip</button>
      </form>
      <button type="button" data-shortcut="a" onClick={() => acted('applied', id)}>
        Mark applied ✓
      </button>
      <button type="button" data-shortcut="p" onClick={() => acted('prepare', id)}>
        Prepare CV
      </button>
    </li>
  );
}

function List({ ids, selectable = true }: { ids: string[]; selectable?: boolean }) {
  return (
    <>
      <input aria-label="Search" />
      <ul>
        {ids.map((id) => (
          <Card key={id} id={id} />
        ))}
      </ul>
      <Triage ids={ids} skip={skip} selectable={selectable} />
    </>
  );
}

const IDS = ['job:a', 'job:b', 'job:c'];
const card = (id: string) => document.querySelector(`[data-job-id="${id}"]`) as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  skip.mockResolvedValue({ ok: true, message: 'Skipped 2 jobs' });
});

describe('moving between cards', () => {
  it('j/k and the arrow keys move a visible focus through the cards and stop at the ends', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('k'); // before any move, k lands on the first card too
    expect(document.activeElement).toBe(card('job:a'));
    await user.keyboard('j');
    expect(document.activeElement).toBe(card('job:b'));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(card('job:c'));
    await user.keyboard('j'); // already the last card
    expect(document.activeElement).toBe(card('job:c'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(card('job:b'));
    await user.keyboard('k');
    expect(document.activeElement).toBe(card('job:a'));
  });

  it('clicking into a card moves the keyboard position there', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    fireEvent.focusIn(card('job:b'));
    await user.keyboard('j');
    expect(document.activeElement).toBe(card('job:c'));
  });
});

describe('acting on the focused card', () => {
  it('Enter opens the posting, o the job page, a marks applied, p prepares', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('jj'); // job:b
    await user.keyboard('{Enter}');
    await user.keyboard('oap');
    expect(acted.mock.calls).toEqual([
      ['open', 'job:b'],
      ['detail', 'job:b'],
      ['applied', 'job:b'],
      ['prepare', 'job:b'],
    ]);
  });

  it('s moves into the skip-reason select; Enter there skips with the chosen reason and focus returns to the card', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('js'); // job:a's select
    const select = screen.getByLabelText('Skip reason job:a');
    expect(document.activeElement).toBe(select);
    await user.selectOptions(select, 'seniority');
    await user.keyboard('{Enter}');
    expect(acted).toHaveBeenCalledWith('skip', 'job:a', 'seniority');
    expect(document.activeElement).toBe(card('job:a'));
  });

  it('Escape in the skip-reason select backs out without skipping', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('js{Escape}');
    expect(acted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(card('job:a'));
  });

  it('acts only while focus is in a card, never on a card that is not highlighted', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('oaps{Enter}x'); // nothing focused yet
    await user.keyboard('j');
    card('job:a').blur(); // e.g. a click on the page background: focus is on <body>
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('oaps{Enter}x');
    expect(acted).not.toHaveBeenCalled();
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('moves focus to the card that took the place of one a refresh removed, so the next key hits a visible card', async () => {
    const user = userEvent.setup();
    const view = render(<List ids={IDS} />);
    await user.keyboard('jj'); // job:b
    await user.keyboard('a');
    expect(acted).toHaveBeenLastCalledWith('applied', 'job:b');
    view.rerender(<List ids={['job:a', 'job:c']} />); // job:b moved to Applied and left the list
    await waitFor(() => expect(document.activeElement).toBe(card('job:c')));
    await user.keyboard('a');
    expect(acted).toHaveBeenLastCalledWith('applied', 'job:c');
    view.rerender(<List ids={['job:a']} />); // the last card left: focus goes to the new last one
    await waitFor(() => expect(document.activeElement).toBe(card('job:a')));
  });

  it('keeps focus on its card when a card above it leaves, and the keys carry on from there', async () => {
    const user = userEvent.setup();
    const view = render(<List ids={IDS} />);
    await user.keyboard('jjj'); // job:c
    view.rerender(<List ids={['job:b', 'job:c']} />);
    await waitFor(() => expect(document.activeElement).toBe(card('job:c')));
    await user.keyboard('k');
    expect(document.activeElement).toBe(card('job:b'));
  });

  it('leaves focus alone when the removed card had lost it to an input', async () => {
    const user = userEvent.setup();
    const view = render(<List ids={IDS} />);
    await user.keyboard('j');
    await user.click(screen.getByLabelText('Search'));
    view.rerender(<List ids={['job:b', 'job:c']} />);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Search')));
  });

  it('does nothing while typing in an input, so the filters stay usable', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.click(screen.getByLabelText('Search'));
    await user.keyboard('japs');
    expect(acted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByLabelText('Search'));
    expect(screen.getByLabelText('Search')).toHaveValue('japs');
  });
});

describe('bulk skip', () => {
  it('x selects cards, and Skip selected sends every id with the one chosen reason', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('jx'); // select job:a
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(card('job:a').dataset.selected).toBe('true');
    await user.keyboard('jjx'); // and job:c
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Skip reason for all selected (optional)'), 'seniority');
    await user.click(screen.getByRole('button', { name: 'Skip selected' }));
    const fd = skip.mock.calls.at(-1)![1];
    expect(fd.getAll('id')).toEqual(['job:a', 'job:c']);
    expect(fd.get('reason')).toBe('seniority');
    // The action answered ok: the selection and the bar go once its state arrives.
    await waitFor(() => expect(screen.queryByText('2 selected')).toBeNull());
    expect(card('job:a').dataset.selected).toBeUndefined();
    expect(card('job:c').dataset.selected).toBeUndefined();
    // The bar is gone, so the page says what happened, until the next selection starts.
    expect(await screen.findByRole('status')).toHaveTextContent('Skipped 2 jobs');
    await user.click(card('job:a'));
    await user.keyboard('x');
    await waitFor(() => expect(screen.queryByText('Skipped 2 jobs')).toBeNull());
  });

  it('x on a selected card unselects it, Escape and Clear empty the selection', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('jxx');
    expect(screen.queryByText(/selected/)).toBeNull();
    await user.keyboard('xjx');
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/selected/)).toBeNull();
    await user.keyboard('x');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('shift-click selects the range from the last x to the clicked card', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('jx'); // anchor at job:a
    fireEvent.click(card('job:c'), { shiftKey: true });
    expect(screen.getByText('3 selected')).toBeInTheDocument();
    expect(IDS.map((id) => card(id).dataset.selected)).toEqual(['true', 'true', 'true']);
  });

  it('leaves shift-click on a link or button to the browser (open in a new window), selecting nothing', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('jx'); // anchor at job:a
    let prevented: boolean | undefined;
    const spy = (e: Event) => {
      prevented = e.defaultPrevented;
      e.preventDefault(); // jsdom cannot open a window
    };
    window.addEventListener('click', spy);
    try {
      fireEvent.click(screen.getByText('job:c title'), { shiftKey: true });
    } finally {
      window.removeEventListener('click', spy);
    }
    expect(prevented).toBe(false);
    expect(acted).toHaveBeenCalledWith('detail', 'job:c');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    fireEvent.click(within(card('job:c')).getByRole('button', { name: 'Mark applied ✓' }), { shiftKey: true });
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('shows the error next to the bar when the bulk skip fails, keeping the selection', async () => {
    skip.mockResolvedValue({ ok: false, message: 'The database is not reachable right now. Try again in a moment.' });
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    await user.keyboard('jx');
    await user.click(screen.getByRole('button', { name: 'Skip selected' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not reachable');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('drops selected cards that are no longer on the page (new filter or page)', async () => {
    const user = userEvent.setup();
    const view = render(<List ids={IDS} />);
    await user.keyboard('jxjx'); // job:a and job:b
    view.rerender(<List ids={['job:b', 'job:c']} />);
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip selected' }));
    expect(skip.mock.calls.at(-1)![1].getAll('id')).toEqual(['job:b']);
  });
});

describe('a list that is not selectable (pipeline tabs, a search across every tab)', () => {
  it('ignores x and shift-click, while moving and the single-card keys keep working', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} selectable={false} />);
    await user.keyboard('jx');
    fireEvent.click(card('job:c'), { shiftKey: true });
    expect(screen.queryByText(/selected/)).toBeNull();
    expect(screen.queryByRole('form', { name: 'Bulk skip' })).toBeNull();
    expect(IDS.map((id) => card(id).dataset.selected)).toEqual([undefined, undefined, undefined]);
    await user.keyboard('ja');
    expect(acted.mock.calls).toEqual([['applied', 'job:b']]);
  });

  it('drops a selection when the list stops being selectable', async () => {
    const user = userEvent.setup();
    const view = render(<List ids={IDS} />);
    await user.keyboard('jx');
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    view.rerender(<List ids={IDS} selectable={false} />);
    await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull());
    expect(card('job:a').dataset.selected).toBeUndefined();
  });

  it('hints at the single-card keys instead of x, and the shortcut list says where bulk skip works', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} selectable={false} />);
    expect(screen.getByText(/act on the focused job/)).toBeInTheDocument();
    expect(screen.queryByText(/selects for bulk skip/)).toBeNull();
    await user.keyboard('?');
    const help = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(help).queryByText('Select for bulk skip')).toBeNull();
    expect(within(help).queryByText('Select a range')).toBeNull();
    expect(within(help).getByText('Close this')).toBeInTheDocument();
    expect(help).toHaveTextContent('Bulk skip (x, Shift+click) works in the Matching and Prepared tabs.');
  });
});

describe('help', () => {
  it('? opens the shortcut list, Escape or Close closes it, and a hint points at it', async () => {
    const user = userEvent.setup();
    render(<List ids={IDS} />);
    expect(screen.getByText(/shows every shortcut/)).toBeInTheDocument();
    await user.keyboard('?');
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Select for bulk skip')).toBeInTheDocument();
    expect(within(dialog).getByText('Clear the selection / close this')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.keyboard('?');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders nothing for an empty list', () => {
    render(<List ids={[]} />);
    expect(screen.queryByText(/Keyboard triage/)).toBeNull();
  });
});
