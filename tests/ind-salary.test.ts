import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ageOn, IND_THRESHOLDS, indSalaryFlag, indThreshold, monthlyEur } from '../src/ind-salary.ts';
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

  it('ageOn: exact from the birth date, else this year minus the birth year, null when unknown', () => {
    assert.equal(ageOn(new Date(2025, 5, 14), { birthDate: '1996-06-15' }), 28, 'the day before the birthday');
    assert.equal(ageOn(new Date(2025, 5, 15), { birthDate: '1996-06-15' }), 29, 'on the birthday');
    assert.equal(ageOn(new Date(2026, 0, 5), { birthDate: '1996-06-15' }), 29, 'January 2026: still 29');
    assert.equal(ageOn(new Date(2026, 0, 5), { birthYear: 1996 }), 30, 'a year alone counts from 1 January');
    assert.equal(ageOn(new Date(2026, 0, 5), { birthDate: '1996-06-15', birthYear: 1990 }), 29, 'the date wins');
    assert.equal(ageOn(in2026, {}), null);
    assert.equal(ageOn(in2026, null), null);
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
      indSalaryFlag(eur(4500, 5200), { birthYear: 1990 }, in2026),
      'salary below the IND highly-skilled-migrant minimum of €5,942/month (30 or over): about €5,200/month',
    );
  });

  it('turning 30 moves a birth date to the higher amount on the birthday itself', () => {
    const s = eur(4500, 5200);
    assert.equal(indSalaryFlag(s, { birthDate: '1996-06-15' }, new Date(2026, 5, 14)), null, 'still 29');
    assert.match(indSalaryFlag(s, { birthDate: '1996-06-15' }, new Date(2026, 5, 15)) ?? '', /€5,942\/month \(30 or over\)/);
  });

  it('under 30 has the lower amount', () => {
    assert.equal(indSalaryFlag(eur(4500, 5200), { birthYear: 2000 }, in2026), null);
    assert.equal(
      indSalaryFlag(eur(3500, 4000), { birthYear: 2000 }, in2026),
      'salary below the IND highly-skilled-migrant minimum of €4,357/month (under 30): about €4,000/month',
    );
  });

  it('a range that only starts below it gets the softer flag', () => {
    assert.equal(
      indSalaryFlag(eur(65_000, 90_000, 'year'), { birthYear: 1990 }, in2026),
      'salary range starts below the IND highly-skilled-migrant minimum of €5,942/month (30 or over)',
    );
  });

  it('an unknown birth year uses the stricter 30-or-over amount and says how to change it', () => {
    assert.match(indSalaryFlag(eur(5000, 5000), null, in2026) ?? '', /€5,942\/month \(30 or over; set birthDate in your profile\)/);
  });

  it('no flag above the amount, without a salary, or for hourly pay', () => {
    assert.equal(indSalaryFlag(eur(6000, 7000), { birthYear: 1990 }, in2026), null);
    assert.equal(indSalaryFlag(eur(90_000, 100_000, 'year'), { birthYear: 1990 }, in2026), null);
    assert.equal(indSalaryFlag(null, { birthYear: 1990 }, in2026), null);
    assert.equal(indSalaryFlag(eur(20, 25, 'hour'), { birthYear: 1990 }, in2026), null);
  });
});

describe('applicant.json birthDate', () => {
  it('is an optional real date between 1940 and 2015, or null', () => {
    for (const ok of ['1996-06-15', '1940-01-01', '2015-12-31', null])
      assert.equal(validateText('applicant', JSON.stringify({ birthDate: ok })).ok, true, String(ok));
    for (const bad of ['1996-02-30', '15-06-1996', '1996/06/15', '1939-12-31', '2016-01-01', 1996])
      assert.equal(validateText('applicant', JSON.stringify({ birthDate: bad })).ok, false, String(bad));
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
