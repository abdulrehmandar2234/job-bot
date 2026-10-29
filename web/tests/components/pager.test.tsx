// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Pager, pageNumbers } from '@/components/pager';

const href = (n: number) => `/?status=new&page=${n}`;
const links = () =>
  within(screen.getByRole('navigation', { name: 'Pages' }))
    .getAllByRole('link')
    .map((a) => [a.textContent, a.getAttribute('href')]);

describe('pageNumbers', () => {
  it('shows the first, the last and two around the current page, with gaps', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumbers(10, 20)).toEqual([1, null, 8, 9, 10, 11, 12, null, 20]);
    expect(pageNumbers(1, 20)).toEqual([1, 2, 3, null, 20]);
    expect(pageNumbers(20, 20)).toEqual([1, null, 18, 19, 20]);
    expect(pageNumbers(4, 20)).toEqual([1, 2, 3, 4, 5, 6, null, 20]);
    expect(pageNumbers(5, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, null, 20]); // a one-page gap shows the page
  });
});

describe('Pager', () => {
  it('renders nothing when everything fits on one page', () => {
    const { container } = render(<Pager page={1} total={25} pageSize={25} href={href} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the range, the current page and links to the others', () => {
    render(<Pager page={2} total={60} pageSize={25} href={href} />);
    expect(screen.getByText('26–50 of 60 jobs')).toBeInTheDocument();
    expect(screen.getByText('2')).toHaveAttribute('aria-current', 'page');
    expect(links()).toEqual([
      ['← Previous', '/?status=new&page=1'],
      ['1', '/?status=new&page=1'],
      ['3', '/?status=new&page=3'],
      ['Next →', '/?status=new&page=3'],
    ]);
  });

  it('disables Previous on the first page and Next on the last', () => {
    const { unmount } = render(<Pager page={1} total={60} pageSize={25} href={href} />);
    expect(screen.getByText('← Previous')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('1–25 of 60 jobs')).toBeInTheDocument();
    unmount();
    render(<Pager page={3} total={60} pageSize={25} href={href} />);
    expect(screen.getByText('Next →')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('51–60 of 60 jobs')).toBeInTheDocument();
  });

  it('says so for a page past the end, with links back', () => {
    render(<Pager page={9} total={30} pageSize={25} href={href} />);
    expect(screen.getByText('Page 9 is past the end')).toBeInTheDocument();
    expect(links()).toContainEqual(['← Previous', '/?status=new&page=2']); // back to the last page
    expect(links()).toContainEqual(['2', '/?status=new&page=2']);
  });
});
