// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobKeys } from '@/components/job-keys';

const push = vi.fn();
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

afterEach(() => push.mockReset());

/** The job page's own buttons the keys reach: Mark applied and the skip-reason select (data-shortcut). */
function page(props: { prev?: string | null; next?: string | null; back?: string } = {}) {
  const applied = vi.fn((e: Event) => e.preventDefault());
  const skipped = vi.fn((e: Event) => e.preventDefault());
  render(
    <>
      <JobKeys prev="/jobs/a?from=x" next="/jobs/c?from=x" back="/?status=new&days=1" {...props} />
      <form onSubmit={(e) => applied(e.nativeEvent)}>
        <button type="submit" data-shortcut="a">
          Mark applied ✓
        </button>
      </form>
      <form onSubmit={(e) => skipped(e.nativeEvent)}>
        <select aria-label="Skip reason" data-shortcut="s" defaultValue="">
          <option value="">why?</option>
        </select>
        <button type="submit">Skip</button>
      </form>
      <input aria-label="Notes" />
      <textarea aria-label="Letter" />
    </>,
  );
  return { applied, skipped };
}

const key = (k: string, target: Element = document.body) => fireEvent.keyDown(target, { key: k });

describe('JobKeys', () => {
  it('j / k open the next / previous job and Esc goes back to the list', () => {
    page();
    key('j');
    key('k');
    key('Escape');
    expect(push.mock.calls.map((c) => c[0])).toEqual(['/jobs/c?from=x', '/jobs/a?from=x', '/?status=new&days=1']);
  });

  it('j / k do nothing at the ends of the list', () => {
    page({ prev: null, next: null });
    key('j');
    key('k');
    expect(push).not.toHaveBeenCalled();
  });

  it('a marks the job applied, s moves into the skip reason, where Enter skips and Esc backs out', () => {
    const { applied, skipped } = page();
    key('a');
    expect(applied).toHaveBeenCalledTimes(1);

    const select = screen.getByRole('combobox', { name: 'Skip reason' });
    key('s');
    expect(select).toHaveFocus();
    key('Escape', select);
    expect(select).not.toHaveFocus();
    expect(push).not.toHaveBeenCalled(); // Esc in the select does not leave the page
    key('s');
    key('Enter', select);
    expect(skipped).toHaveBeenCalledTimes(1);
  });

  it('ignores every key while typing, and modified keys', () => {
    const { applied } = page();
    for (const field of [screen.getByRole('textbox', { name: 'Notes' }), screen.getByRole('textbox', { name: 'Letter' })]) {
      field.focus();
      for (const k of ['j', 'k', 'a', 's', 'Escape']) key(k, field);
    }
    fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'a', ctrlKey: true });
    expect(push).not.toHaveBeenCalled();
    expect(applied).not.toHaveBeenCalled();
  });

  it('leaves Esc to an open dialog', () => {
    page();
    const dialog = document.createElement('dialog');
    dialog.setAttribute('open', '');
    document.body.append(dialog);
    key('Escape');
    expect(push).not.toHaveBeenCalled();
    dialog.remove();
  });

  it('lists j / k only when there is a list to walk', () => {
    const { unmount } = render(<JobKeys back="/" />);
    expect(screen.getByText('Keys: a mark applied · s skip · Esc back to the list')).toBeInTheDocument();
    unmount();
  });
});
