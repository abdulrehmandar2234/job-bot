// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SalaryFilter, SalaryOnlyToggle, salaryParams, SalaryTag } from '@/components/salary';
import { currencyCodes } from '@/lib/salary';

const job = { salary_min: 18_000, salary_max: 22_000, salary_currency: 'AED' as const, salary_period: 'month' as const, country: 'AE' };
const params = (q: Record<string, string>) => salaryParams((k) => q[k]);

describe('SalaryTag', () => {
  it('shows the range', () => {
    render(<SalaryTag job={job} expected={{}} />);
    expect(screen.getByText('💰 AED 18k–22k / month')).toBeInTheDocument();
    expect(screen.queryByText(/below your expectation/)).not.toBeInTheDocument();
  });

  it('hints when the job pays less than expected for its country', () => {
    render(<SalaryTag job={job} expected={{ AE: { amount: 25_000, currency: 'AED', period: 'month' } }} />);
    expect(screen.getByText(/below your expectation/)).toBeInTheDocument();
  });

  it('renders nothing without a salary', () => {
    const { container } = render(
      <SalaryTag job={{ ...job, salary_min: null, salary_max: null, salary_currency: null, salary_period: null }} expected={{}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('salaryParams', () => {
  it('turns the typed amount into euros per year and keeps the query for the tabs', () => {
    const p = params({ sal: '20000', cur: 'AED', per: 'month', salonly: '1' });
    expect(p.filter).toEqual({ minSalary: 60_000, salaryOnly: true });
    expect(p.query).toEqual({ sal: '20000', cur: 'AED', per: 'month', salonly: '1' });
  });

  it('defaults to no filter in EUR per year, and ignores junk', () => {
    expect(params({})).toEqual({
      params: { sal: undefined, cur: 'EUR', per: 'year', only: false },
      filter: { minSalary: undefined, salaryOnly: false },
      query: {},
    });
    expect(params({ sal: '-5', cur: 'BTC', per: 'week' }).params).toEqual({ sal: undefined, cur: 'EUR', per: 'year', only: false });
  });

  it("falls back to the user's currency, and takes any currency in the table", () => {
    expect(salaryParams(() => undefined, 'INR').params.cur).toBe('INR');
    expect(salaryParams((k) => ({ cur: 'BTC' })[k], 'PKR').params.cur).toBe('PKR');
    const p = params({ sal: '1800000', cur: 'INR', per: 'year' });
    expect(p.params.cur).toBe('INR');
    expect(p.filter.minSalary).toBe(18_900);
  });
});

describe('SalaryFilter', () => {
  it('renders the inputs with the current values', () => {
    render(
      <form>
        <SalaryFilter params={params({ sal: '5000', cur: 'EUR', per: 'month', salonly: '1' }).params} />
        <SalaryOnlyToggle params={params({ salonly: '1' }).params} />
      </form>,
    );
    expect(screen.getByRole('spinbutton', { name: 'Min salary' })).toHaveValue(5000);
    expect(screen.getByRole('combobox', { name: 'Salary currency' })).toHaveValue('EUR');
    expect(screen.getByRole('combobox', { name: 'Salary period' })).toHaveValue('month');
    expect(screen.getByRole('checkbox', { name: 'only with salary' })).toBeChecked();
    // Every currency of src/currencies.json, A–Z, then the periods.
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options.slice(-2)).toEqual(['/ year', '/ month']);
    const codes = options.slice(0, -2);
    expect(codes).toEqual(currencyCodes());
    expect(codes).toEqual([...codes].sort());
    expect(codes).toEqual(expect.arrayContaining(['AED', 'BDT', 'EUR', 'INR', 'PKR', 'USD']));
  });
});
