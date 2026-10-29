import type { SalaryCurrency, SalaryPeriod } from '../../src/types';
import { belowExpectation, CURRENCIES, formatSalary, yearlyEur, type Expectation, type JobSalary } from '@/lib/salary';

/** The salary of a job, e.g. "💰 AED 20k–25k / month", with a hint when it is below what you expect for that country. */
export function SalaryTag({ job, expected }: { job: JobSalary & { country: string | null }; expected: Record<string, Expectation> }) {
  const text = formatSalary(job);
  if (!text) return null;
  const below = belowExpectation(job, expected);
  return (
    <p className="text-sm">
      <span className="font-medium text-zinc-700 dark:text-zinc-300">💰 {text}</span>
      {below && <span className="text-amber-700 dark:text-amber-400" title="From expectedSalary in cv/applicant.json">
        {' '}· below your expectation</span>}
    </p>
  );
}

export type SalaryParams = { sal?: number; cur: SalaryCurrency; per: SalaryPeriod; only: boolean };

/** Reads the salary filter from the list page's query string (sal, cur, per, salonly). */
export function salaryParams(one: (k: string) => string | undefined) {
  const p: SalaryParams = {
    sal: Number(one('sal')) > 0 ? Number(one('sal')) : undefined,
    cur: CURRENCIES.includes(one('cur') as SalaryCurrency) ? one('cur') as SalaryCurrency : 'EUR',
    per: one('per') === 'month' ? 'month' : 'year',
    only: one('salonly') === '1',
  };
  return {
    params: p,
    filter: { minSalary: p.sal ? yearlyEur(p.sal, p.cur, p.per) : undefined, salaryOnly: p.only },
    // Kept on the status tabs' links.
    query: { ...(p.sal && { sal: String(p.sal), cur: p.cur, per: p.per }), ...(p.only && { salonly: '1' }) },
  };
}

/** "Min salary" inputs for the list page's filter form. Compared in euros per year with approximate rates. */
export function SalaryFilter({ params }: { params: SalaryParams }) {
  return (
    <span className="flex flex-wrap items-center gap-2" title="Compared in euros per year with approximate exchange rates">
      <input name="sal" type="number" min={0} step={500} defaultValue={params.sal ?? ''} placeholder="Min salary"
        aria-label="Min salary" className="input w-28" />
      <select name="cur" defaultValue={params.cur} aria-label="Salary currency" className="input">
        {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select name="per" defaultValue={params.per} aria-label="Salary period" className="input">
        <option value="year">/ year</option>
        <option value="month">/ month</option>
      </select>
      <label className="flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
        <input type="checkbox" name="salonly" value="1" defaultChecked={params.only} /> only with salary
      </label>
    </span>
  );
}
