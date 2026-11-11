import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ageIn, IND_THRESHOLDS, indSalaryFlag, indThreshold, monthlyEur } from '../src/ind-salary.ts';
import { validateText } from '../src/settings.ts';
import type { Salary } from '../src/types.ts';

const eur = (min: number | null, max: number | null, period: Salary['period'] = 'month'): Salary => ({ min, max, currency: 'EUR', period });
const in2026 = new Date(2026, 10, 11);

describe('IND thresholds', () => {
  it("has 2026's amounts (gross per month, without holiday allowance) and uses the latest row for a later year", () => {
    assert.deepEqual(IND_THRESHOLDS[2026], { over30: 5942, under30: 4357 });
    assert.deepEqual(indThreshold(2026), IND_THRESHOLDS[2026]);
    assert.deepEqual(indThreshold(2031), IND_THRESHOLDS[2026], 'a year without a row: the latest one before it');
    assert.deepEqual(indThreshold(2020), IND_THRESHOLDS[2026], 'before the first row: the first one');
  });

  it('ageIn: this year minus the birth year, null when unknown', () => {
    assert.equal(ageIn(2026, 1996), 30);
    assert.equal(ageIn(2026, null), null);
    assert.equal(ageIn(2026, undefined), null);
  });
});

describe('monthlyEur', () => {
  it('a yearly salary is 12 months plus 8% holiday allowance; a monthly one stays; another currency is converted', () => {
    assert.equal(monthlyEur(eur(64_800, null, 'year'), 'min'), 5000);
    assert.equal(monthlyEur(eur(4500, 5200), 'max'), 5200);
    assert.equal(monthlyEur(eur(4500, null), 'max'), 4500, 'a missing end uses the other one');
    assert.ok((monthlyEur({ min: 100_000, max: null, currency: 'USD', period: 'year' }, 'min') ?? 0) > 6000);
    assert.equal(monthlyEur(eur(50, 60, 'hour'), 'max'), null, 'hourly pay is not compared');
  });
});

describe('indSalaryFlag', () => {
  it('flags a salary whose top is below the amount for the candidate (30 or over)', () => {
    assert.equal(
      indSalaryFlag(eur(4500, 5200), 1990, in2026),
      'salary below the IND highly-skilled-migrant minimum of €5,942/month (30 or over): about €5,200/month',
    );
  });

  it('under 30 has the lower amount', () => {
    assert.equal(indSalaryFlag(eur(4500, 5200), 2000, in2026), null);
    assert.equal(
      indSalaryFlag(eur(3500, 4000), 2000, in2026),
      'salary below the IND highly-skilled-migrant minimum of €4,357/month (under 30): about €4,000/month',
    );
  });

  it('a range that only starts below it gets the softer flag', () => {
    assert.equal(
      indSalaryFlag(eur(65_000, 90_000, 'year'), 1990, in2026),
      'salary range starts below the IND highly-skilled-migrant minimum of €5,942/month (30 or over)',
    );
  });

  it('an unknown birth year uses the stricter 30-or-over amount and says how to change it', () => {
    assert.match(indSalaryFlag(eur(5000, 5000), null, in2026) ?? '', /€5,942\/month \(30 or over; set birthYear in your profile\)/);
  });

  it('no flag above the amount, without a salary, or for hourly pay', () => {
    assert.equal(indSalaryFlag(eur(6000, 7000), 1990, in2026), null);
    assert.equal(indSalaryFlag(eur(90_000, 100_000, 'year'), 1990, in2026), null);
    assert.equal(indSalaryFlag(null, 1990, in2026), null);
    assert.equal(indSalaryFlag(eur(20, 25, 'hour'), 1990, in2026), null);
  });
});

describe('applicant.json birthYear', () => {
  it('is an optional whole year between 1940 and 2015, or null', () => {
    for (const ok of [1940, 1995, 2015, null])
      assert.equal(validateText('applicant', JSON.stringify({ birthYear: ok })).ok, true, String(ok));
    assert.equal(validateText('applicant', '{}').ok, true);
    for (const bad of [1939, 2016, 1995.5, '1995'])
      assert.equal(validateText('applicant', JSON.stringify({ birthYear: bad })).ok, false, String(bad));
  });
});
