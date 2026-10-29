import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { belowExpectation, EUR_RATE, formatSalary, loadExpectations, parseExpectation, PER_YEAR, yearlyEur } from '@/lib/salary';

const job = (min: number | null, max: number | null, cur: 'AED' | 'EUR' | 'USD' | 'SAR' | 'GBP' | 'PKR', per: 'year' | 'month' | 'hour', country = 'AE') =>
  ({ salary_min: min, salary_max: max, salary_currency: cur, salary_period: per, country });

describe('yearlyEur', () => {
  it('converts every currency to euros and every period to a year', () => {
    expect(yearlyEur(60_000, 'EUR', 'year')).toBe(60_000);
    expect(yearlyEur(5_000, 'EUR', 'month')).toBe(60_000);
    expect(yearlyEur(20_000, 'AED', 'month')).toBe(60_000);
    expect(yearlyEur(50, 'USD', 'hour')).toBe(Math.round(50 * 0.92 * 2080));
    expect(yearlyEur(1_000_000, 'PKR', 'month')).toBe(39_600);
  });

  it('has a rate for every currency the bot parses, and the same periods', () => {
    expect(Object.keys(EUR_RATE).sort()).toEqual(['AED', 'EUR', 'GBP', 'PKR', 'SAR', 'USD']);
    expect(Object.keys(PER_YEAR).sort()).toEqual(['hour', 'month', 'year']);
  });
});

describe('formatSalary', () => {
  it('shows ranges, open ends and single values with k / M', () => {
    expect(formatSalary(job(20_000, 25_000, 'AED', 'month'))).toBe('AED 20k–25k / month');
    expect(formatSalary(job(null, 5_500, 'EUR', 'month'))).toBe('up to EUR 5.5k / month');
    expect(formatSalary(job(120_000, null, 'USD', 'year'))).toBe('from USD 120k / year');
    expect(formatSalary(job(300_000, 300_000, 'AED', 'year'))).toBe('AED 300k / year');
    expect(formatSalary(job(2_500_000, 3_000_000, 'PKR', 'year'))).toBe('PKR 2.5M–3M / year');
    expect(formatSalary(job(40, 60, 'USD', 'hour'))).toBe('USD 40–60 / hour');
  });

  it('is null without a salary', () => {
    expect(formatSalary({ salary_min: null, salary_max: null, salary_currency: null, salary_period: null })).toBeNull();
  });
});

describe('expectations', () => {
  it('reads a plain number in the country\'s currency: monthly in the Gulf, yearly elsewhere', () => {
    expect(parseExpectation(25000, 'AE')).toEqual({ amount: 25_000, currency: 'AED', period: 'month' });
    expect(parseExpectation(70000, 'NL')).toEqual({ amount: 70_000, currency: 'EUR', period: 'year' });
    expect(parseExpectation(90000, 'remote')).toEqual({ amount: 90_000, currency: 'USD', period: 'year' });
  });

  it('reads text with its own currency and period, taking the low end of a range', () => {
    expect(parseExpectation('AED 25,000 per month, negotiable', 'AE')).toEqual({ amount: 25_000, currency: 'AED', period: 'month' });
    expect(parseExpectation('SAR 22-25k monthly', 'SA')).toEqual({ amount: 22_000, currency: 'SAR', period: 'month' });
    expect(parseExpectation('€5.500 bruto per maand', 'NL')).toEqual({ amount: 5_500, currency: 'EUR', period: 'month' });
    expect(parseExpectation('USD 60k a year', 'remote')).toEqual({ amount: 60_000, currency: 'USD', period: 'year' });
  });

  it('ignores unknown values', () => {
    expect(parseExpectation(null, 'AE')).toBeNull();
    expect(parseExpectation('negotiable', 'AE')).toBeNull();
    expect(parseExpectation(5000, 'XX')).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), 'web-salary-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads cv/applicant.json, and is empty when it is missing or broken', () => {
    const file = join(dir, 'applicant.json');
    writeFileSync(file, JSON.stringify({ expectedSalary: { AE: 25000, SA: null, NL: 'EUR 70k', remote: 'ask me' } }));
    expect(loadExpectations(file)).toEqual({
      AE: { amount: 25_000, currency: 'AED', period: 'month' }, NL: { amount: 70_000, currency: 'EUR', period: 'year' },
    });
    expect(loadExpectations(join(dir, 'nope.json'))).toEqual({});
    writeFileSync(file, '{');
    expect(loadExpectations(file)).toEqual({});
  });

  it('flags a job only when the top of its range is below the expectation, across currencies', () => {
    const expected = { AE: { amount: 25_000, currency: 'AED' as const, period: 'month' as const },
      remote: { amount: 60_000, currency: 'EUR' as const, period: 'year' as const } };
    expect(belowExpectation(job(18_000, 22_000, 'AED', 'month'), expected)).toBe(true);
    expect(belowExpectation(job(20_000, 26_000, 'AED', 'month'), expected)).toBe(false);
    expect(belowExpectation(job(250_000, 280_000, 'AED', 'year'), expected)).toBe(true);
    // Remote jobs use the "remote" expectation: USD 70k a year is about EUR 64k.
    expect(belowExpectation(job(null, 70_000, 'USD', 'year', 'RM'), expected)).toBe(false);
    expect(belowExpectation(job(50_000, 60_000, 'USD', 'year', 'RM'), expected)).toBe(true);
    // No expectation for the country, or no salary: no hint.
    expect(belowExpectation(job(1_000, 2_000, 'SAR', 'month', 'SA'), expected)).toBe(false);
    expect(belowExpectation({ salary_min: null, salary_max: null, salary_currency: null, salary_period: null, country: 'AE' }, expected)).toBe(false);
  });
});
