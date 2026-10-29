import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, SalaryCurrency, SalaryPeriod } from '../../src/types';
import { BOT_ROOT } from './bot';

// Salaries come in six currencies and three periods (src/salary.ts). To compare them, everything is turned into
// euros per year. The rates are approximate and fixed on purpose: good enough to filter and hint, not for accounting.
export const EUR_RATE: Record<SalaryCurrency, number> = {
  EUR: 1, USD: 0.92, GBP: 1.17, AED: 0.25, SAR: 0.245, PKR: 0.0033,
};
export const PER_YEAR: Record<SalaryPeriod, number> = { year: 1, month: 12, hour: 2080 }; // 40 h x 52 weeks
export const CURRENCIES = Object.keys(EUR_RATE) as SalaryCurrency[];

export type JobSalary = Pick<Job, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>;

export const yearlyEur = (amount: number, currency: SalaryCurrency, period: SalaryPeriod) =>
  Math.round(amount * EUR_RATE[currency] * PER_YEAR[period]);

/** SQL for a job's best pay (top of its range) in euros per year; NULL without a salary. Built from the tables above. */
export const SQL_YEARLY_EUR = `(coalesce(salary_max, salary_min)
  * CASE salary_currency ${CURRENCIES.map((c) => `WHEN '${c}' THEN ${EUR_RATE[c]}`).join(' ')} END
  * CASE salary_period ${Object.entries(PER_YEAR).map(([p, n]) => `WHEN '${p}' THEN ${n}`).join(' ')} END)`;

const short = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n));

/** "AED 20k–25k / month", "up to EUR 5.5k / month", "from USD 120k / year"; null without a salary. */
export function formatSalary(j: JobSalary): string | null {
  const { salary_min: lo, salary_max: hi, salary_currency: cur, salary_period: per } = j;
  if (!cur || !per || (lo == null && hi == null)) return null;
  const amount = lo == null ? `up to ${cur} ${short(hi!)}` : hi == null ? `from ${cur} ${short(lo)}`
    : lo === hi ? `${cur} ${short(lo)}` : `${cur} ${short(lo)}–${short(hi)}`;
  return `${amount} / ${per}`;
}

// What the user expects per country (cv/applicant.json expectedSalary: AE, SA, NL, remote). A plain number is in the
// country's currency, per month in the Gulf and per year elsewhere; a text like "AED 25,000 per month" or "EUR 70k"
// says it itself.
const LOCAL: Record<string, SalaryCurrency> = { AE: 'AED', SA: 'SAR', NL: 'EUR', remote: 'USD' };
const CURRENCY_WORDS: [RegExp, SalaryCurrency][] = [[/\bAED\b|dirham/i, 'AED'], [/\bSAR\b|riyal/i, 'SAR'], [/\bEUR\b|€|euro/i, 'EUR'],
  [/\bUSD\b|\$/i, 'USD'], [/\bGBP\b|£/i, 'GBP'], [/\bPKR\b|\bRs\b/i, 'PKR']];

export type Expectation = { amount: number; currency: SalaryCurrency; period: SalaryPeriod };

export function parseExpectation(value: unknown, country: string): Expectation | null {
  const currency0 = LOCAL[country];
  const period0: SalaryPeriod = country === 'AE' || country === 'SA' ? 'month' : 'year';
  if (typeof value === 'number' && value > 0 && currency0) return { amount: value, currency: currency0, period: period0 };
  if (typeof value !== 'string') return null;
  // The lowest number named (with its k), so "AED 22-25k" expects 22k.
  const nums = [...value.matchAll(/(\d[\d,.]*)\s*(k\b)?/gi)].map((m) => ({ n: Number(m[1].replace(/[,.](?=\d{3}\b)/g, '').replace(',', '.')), k: !!m[2] }));
  const anyK = nums.some((x) => x.k);
  const amounts = nums.map((x) => x.n * (x.k || (anyK && x.n < 1000) ? 1000 : 1)).filter((n) => n > 0);
  const currency = CURRENCY_WORDS.find(([re]) => re.test(value))?.[1] ?? currency0;
  if (!amounts.length || !currency) return null;
  const period: SalaryPeriod = /month|maand|\bpm\b/i.test(value) ? 'month' : /hour|uur/i.test(value) ? 'hour'
    : /year|annual|annum|jaar|\bpa\b/i.test(value) ? 'year' : period0;
  return { amount: Math.min(...amounts), currency, period };
}

/** Expectations per country key from cv/applicant.json; empty when the file is missing or unreadable. */
export function loadExpectations(file = join(BOT_ROOT, 'cv', 'applicant.json')): Record<string, Expectation> {
  try {
    const expected = JSON.parse(readFileSync(file, 'utf8')).expectedSalary ?? {};
    return Object.fromEntries(Object.entries(expected)
      .map(([k, v]) => [k, parseExpectation(v, k)] as const)
      .filter((e): e is [string, Expectation] => e[1] != null));
  } catch {
    return {};
  }
}

/** True when even the top of the job's range is below what the user expects for that country (a hint, never a filter). */
export function belowExpectation(j: JobSalary & { country: string | null }, expected: Record<string, Expectation>): boolean {
  const e = expected[j.country === 'RM' ? 'remote' : j.country ?? ''];
  const top = j.salary_max ?? j.salary_min;
  if (!e || top == null || !j.salary_currency || !j.salary_period) return false;
  return yearlyEur(top, j.salary_currency, j.salary_period) < yearlyEur(e.amount, e.currency, e.period);
}
