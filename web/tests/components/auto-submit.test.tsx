// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoCheckbox, AutoSelect } from '@/components/auto-submit';

afterEach(() => {
  vi.restoreAllMocks();
});

// jsdom does not navigate on submit: record what requestSubmit would send instead.
function spySubmit() {
  const sent: Record<string, string>[] = [];
  const spy = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (this: HTMLFormElement) {
    sent.push(Object.fromEntries(new FormData(this)) as Record<string, string>);
  });
  return { spy, sent };
}

function Form() {
  return (
    <form aria-label="Filters">
      <input type="hidden" name="status" value="new" />
      <input type="search" name="q" aria-label="Search" defaultValue="php" />
      <AutoSelect name="size" aria-label="Jobs per page" defaultValue="25">
        <option value="10">10 per page</option>
        <option value="25">25 per page</option>
      </AutoSelect>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: AutoCheckbox renders the checkbox input */}
      <label>
        <AutoCheckbox name="visa" value="1" /> Visa
      </label>
      <button type="submit">Apply filters</button>
    </form>
  );
}

describe('AutoSelect', () => {
  it('submits its form with every field as soon as the choice changes', () => {
    const { spy, sent } = spySubmit();
    render(<Form />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Jobs per page' }), { target: { value: '10' } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ status: 'new', q: 'php', size: '10' }]);
  });

  it('still calls its own onChange, and renders a plain named select that the submit button sends without JS', () => {
    const { spy } = spySubmit();
    const onChange = vi.fn();
    render(
      <form>
        <AutoSelect name="sort" aria-label="Sort" defaultValue="score" onChange={onChange}>
          <option value="score">Best match</option>
          <option value="newest">Newest</option>
        </AutoSelect>
      </form>,
    );
    const select = screen.getByRole('combobox', { name: 'Sort' });
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveAttribute('name', 'sort');
    fireEvent.change(select, { target: { value: 'newest' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does nothing outside a form', () => {
    const { spy } = spySubmit();
    render(
      <AutoSelect aria-label="Loose">
        <option value="a">a</option>
        <option value="b">b</option>
      </AutoSelect>,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Loose' }), { target: { value: 'b' } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('AutoCheckbox', () => {
  it('is a checkbox that submits its form when ticked', () => {
    const { sent } = spySubmit();
    render(<Form />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Visa' }));
    expect(sent).toEqual([{ status: 'new', q: 'php', size: '25', visa: '1' }]);
  });
});
