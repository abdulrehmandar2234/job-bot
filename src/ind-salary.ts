import { eurRate } from './currencies.ts';
import type { Salary } from './types.ts';

// The Dutch IND's salary criterion for a highly skilled migrant (kennismigrant): an employer can only sponsor the
// visa when the gross monthly salary, without the 8% holiday allowance, is at least this amount. It depends on the
// candidate's age and changes every 1 January (https://ind.nl/en/required-amounts-income-requirements). Add the new
// year's row each January; a year without a row uses the latest one before it.

export type IndThreshold = { over30: number; under30: number };

/** Gross euros per month, without holiday allowance, by the year they apply in. */
export const IND_THRESHOLDS: Record<number, IndThreshold> = {
  2026: { over30: 5942, under30: 4357 },
};

/** Dutch yearly salaries usually include the 8% holiday allowance: a year is 12 months plus 8%. */
export const MONTHS_PER_YEAR_WITH_HOLIDAY_PAY = 12 * 1.08;

/** The threshold that applies in `year` (the latest row at or before it, else the earliest row). */
export function indThreshold(year: number): IndThreshold {
  const years = Object.keys(IND_THRESHOLDS)
    .map(Number)
    .sort((a, b) => a - b);
  const at = years.filter((y) => y <= year).at(-1) ?? years[0];
  return IND_THRESHOLDS[at];
}

/** The candidate's age this year from a birth year, or null when unknown. */
export const ageIn = (year: number, birthYear: number | null | undefined) => (birthYear ? year - birthYear : null);

/**
 * A salary as euros per month without holiday allowance, or null for hourly pay or a salary with no amount. Yearly
 * amounts are divided by 12.96 (12 months plus 8% holiday allowance), the usual way Dutch postings state a year.
 */
export function monthlyEur(s: Salary, which: 'min' | 'max'): number | null {
  const amount = s[which] ?? s[which === 'min' ? 'max' : 'min'];
  if (!amount || s.period === 'hour') return null;
  const eur = amount * eurRate(s.currency);
  return Math.round(s.period === 'year' ? eur / MONTHS_PER_YEAR_WITH_HOLIDAY_PAY : eur);
}

/**
 * A flag for a Dutch job whose posted salary cannot meet the IND criterion for the candidate: even its top is below
 * the amount for their age (30 or over when the birth year is unknown, the stricter one), or only its bottom is.
 * Null when it meets it, or when the salary is unknown or hourly.
 */
export function indSalaryFlag(s: Salary | null, birthYear: number | null | undefined, now = new Date()): string | null {
  if (!s) return null;
  const year = now.getFullYear();
  const age = ageIn(year, birthYear);
  const t = indThreshold(year);
  const need = age !== null && age < 30 ? t.under30 : t.over30;
  const who = age === null ? '30 or over; set birthYear in your profile' : age < 30 ? 'under 30' : '30 or over';
  const top = monthlyEur(s, 'max');
  const bottom = monthlyEur(s, 'min');
  if (top === null || bottom === null) return null;
  const amount = `€${need.toLocaleString('en-US')}/month (${who})`;
  if (top < need) return `salary below the IND highly-skilled-migrant minimum of ${amount}: about €${top.toLocaleString('en-US')}/month`;
  if (bottom < need) return `salary range starts below the IND highly-skilled-migrant minimum of ${amount}`;
  return null;
}
