import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePayRange, parseSalary, rowSalary, structuredSalary } from '../src/salary.ts';
import type { Salary } from '../src/types.ts';

const S = (min: number | null, max: number | null, currency: Salary['currency'], period: Salary['period']): Salary => ({
  min,
  max,
  currency,
  period,
});

// Real-world wording from postings in the target countries and on remote boards.
const FOUND: [string, Salary][] = [
  ['Salary: AED 20,000 - 25,000 per month', S(20_000, 25_000, 'AED', 'month')],
  ['Package: AED 20k–25k / month + visa + medical', S(20_000, 25_000, 'AED', 'month')],
  ['Monthly salary AED 18,000 to AED 22,000 all inclusive', S(18_000, 22_000, 'AED', 'month')],
  ['Compensation: AED20,000-AED25,000 monthly', S(20_000, 25_000, 'AED', 'month')],
  ['We offer 15000-20000 AED/month plus housing', S(15_000, 20_000, 'AED', 'month')],
  ['Salary range: AED 25-30k per month', S(25_000, 30_000, 'AED', 'month')],
  ['Total package of AED 300,000 per annum', S(300_000, 300_000, 'AED', 'year')],
  ['Salary: SAR 25,000 - 30,000 monthly', S(25_000, 30_000, 'SAR', 'month')],
  ['Up to SAR 35,000 per month depending on experience', S(null, 35_000, 'SAR', 'month')],
  ['Base salary between 22,000 and 28,000 riyals per month', S(22_000, 28_000, 'SAR', 'month')],
  ['Salaris: €4.500 - €6.000 bruto per maand', S(4_500, 6_000, 'EUR', 'month')],
  ['Je verdient tot €5.500 bruto per maand', S(null, 5_500, 'EUR', 'month')],
  ['Bruto maandsalaris tussen € 4.000,- en € 5.200,-', S(4_000, 5_200, 'EUR', 'month')],
  ['€ 4.800 bruto', S(4_800, 4_800, 'EUR', 'month')],
  ['Salary: €60,000 - €75,000 per year + 8% holiday allowance', S(60_000, 75_000, 'EUR', 'year')],
  ['Salary range €65k-€80k', S(65_000, 80_000, 'EUR', 'year')],
  ['Gross annual salary from 55.000 EUR', S(55_000, null, 'EUR', 'year')],
  ['Senior Engineer ($120k - $150k)', S(120_000, 150_000, 'USD', 'year')],
  ['The base pay range for this role is $140,000—$180,000 USD', S(140_000, 180_000, 'USD', 'year')],
  ['Compensation: USD 4,000 - 6,000 per month (remote, paid via Deel)', S(4_000, 6_000, 'USD', 'month')],
  ['Rate: $40 - $60 per hour', S(40, 60, 'USD', 'hour')],
  ['US$90k–110k annually', S(90_000, 110_000, 'USD', 'year')],
  ['Salary: £70,000 – £85,000 per annum', S(70_000, 85_000, 'GBP', 'year')],
  ['Salary: PKR 400,000 - 600,000 per month', S(400_000, 600_000, 'PKR', 'month')],
  ['Salary Rs. 350,000/month', S(350_000, 350_000, 'PKR', 'month')],
  ['Salary: AED 20,000+ per month', S(20_000, null, 'AED', 'month')],
];

// Numbers that are not a salary, or a salary too unclear to trust.
const NOT_FOUND = [
  '7+ years of experience with Laravel and 3-5 years with React',
  'A team of 500 employees across 12 countries, founded in 2014',
  'We raised $20M in our Series B led by Sequoia',
  'Backed by $1.5 billion in funding',
  'Series A: $12,000,000 raised last year',
  'Our platform processes AED 5 billion in payments',
  'Annual learning budget of €1,500 and a €30 monthly gym allowance',
  'Signing bonus of $10,000',
  'A $5k home office budget',
  'Relocation allowance AED 10,000',
  'Customers in 40+ countries and 10,000 merchants',
  'Salary: competitive, plus annual bonus',
  'Call us on +971 4 123 4567',
  'CA$120,000 - CA$140,000 per year',
  'Salary AED 100',
  'Salary: AED 110,000', // too big for a month, too small for a year
  'AED 20,000 - 90,000 per month', // range too wide to mean anything
  '$120,000', // no salary wording, no period, no range
  'Salary: 20,000 - 25,000 per month', // no currency
  'Laravel 10, PHP 8.3, Node 20 and React 18',
  'Grew revenue to $120,000 per month within a year',
  'Equity grant worth $50,000 per year, vesting over 4 years',
  'Work 40 hours per week, 5 days per week',
];

describe('parseSalary', () => {
  for (const [text, want] of FOUND) {
    it(`finds ${JSON.stringify(text)}`, () => assert.deepEqual(parseSalary(text), want));
  }
  for (const text of NOT_FOUND) {
    it(`ignores ${JSON.stringify(text)}`, () => assert.equal(parseSalary(text), null));
  }

  it('finds the salary in a long description past other numbers', () => {
    const text =
      `Senior Laravel Developer\nAbout us: founded in 2015, 250 employees, $40M raised.\n` +
      `Requirements: 5+ years of PHP.\nWhat we offer: AED 22,000 - 28,000 per month, 30 days annual leave.`;
    assert.deepEqual(parseSalary(text), S(22_000, 28_000, 'AED', 'month'));
  });

  it('skips a bonus amount and keeps the salary next to it', () => {
    assert.deepEqual(parseSalary('Signing bonus $10,000. Salary: $130,000 - $150,000 per year.'), S(130_000, 150_000, 'USD', 'year'));
  });
});

describe('structuredSalary', () => {
  it('reads numbers or numeric strings and orders the ends', () => {
    assert.deepEqual(structuredSalary(60000, '80000.4', 'eur'), S(60_000, 80_000, 'EUR', 'year'));
    assert.deepEqual(structuredSalary(90000, 70000, 'USD'), S(70_000, 90_000, 'USD', 'year'));
    assert.deepEqual(structuredSalary(null, 5000, 'AED', 'month'), S(null, 5_000, 'AED', 'month'));
  });

  it('is null for empty or zero values and for currencies outside the table', () => {
    assert.equal(structuredSalary(0, 0, 'USD'), null);
    assert.equal(structuredSalary(undefined, '', 'USD'), null);
    assert.equal(structuredSalary(50000, 60000, 'CAD'), null);
  });
});

describe('rowSalary', () => {
  it('rebuilds a stored salary, and is null when there is none', () => {
    assert.deepEqual(rowSalary({ salary_min: 1, salary_max: 2, salary_currency: 'AED', salary_period: 'month' }), S(1, 2, 'AED', 'month'));
    assert.equal(rowSalary({ salary_min: null, salary_max: null, salary_currency: null, salary_period: null }), null);
  });
});

describe('parsePayRange (a job site\'s own pay field, e.g. LinkedIn "Base pay range")', () => {
  const pay = (min: number | null, max: number | null, currency: Salary['currency'], period: Salary['period']): Salary => ({
    min,
    max,
    currency,
    period,
  });

  it('reads both ends with currency, decimals, K and period, taking the amounts as given', () => {
    assert.deepEqual(parsePayRange('$50.00/mo - $100.00/mo'), pay(50, 100, 'USD', 'month'));
    assert.deepEqual(parsePayRange('  $120,000.00/yr - $150,000.00/yr '), pay(120000, 150000, 'USD', 'year'));
    assert.deepEqual(parsePayRange('€60K/yr - €80K/yr'), pay(60000, 80000, 'EUR', 'year'));
    assert.deepEqual(parsePayRange('$40.00/hr - $55.00/hr'), pay(40, 55, 'USD', 'hour'));
    assert.deepEqual(parsePayRange('SAR 15,000.00/mo - SAR 20,000.00/mo'), pay(15000, 20000, 'SAR', 'month'));
    assert.deepEqual(parsePayRange('AED 25,000.00/mo'), pay(25000, 25000, 'AED', 'month'));
    assert.deepEqual(parsePayRange('£45,000.00/yr'), pay(45000, 45000, 'GBP', 'year'));
  });

  it('returns null for nothing, unknown currencies, or ends that disagree', () => {
    for (const t of [null, undefined, '', 'Competitive', 'CHF 9,000/mo', '$5,000/mo - €6,000/mo', '$50/hr - $9,000/mo'])
      assert.equal(parsePayRange(t), null, String(t));
  });
});

describe('parseSalary: a range with a period after each end', () => {
  it('"$120,000/yr - $150,000/yr" reads both ends', () => {
    assert.deepEqual(parseSalary('Salary: $120,000/yr - $150,000/yr'), { min: 120000, max: 150000, currency: 'USD', period: 'year' });
    assert.deepEqual(parseSalary('Pay: AED 20,000/month - AED 25,000/month'), { min: 20000, max: 25000, currency: 'AED', period: 'month' });
  });
});

describe('parseSalary: Indian rupees', () => {
  it('reads ₹, INR, Indian digit grouping, lakh, crore and LPA (lakh per annum)', () => {
    assert.deepEqual(parseSalary('CTC: ₹12 LPA'), S(1_200_000, 1_200_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: 12-18 LPA'), S(1_200_000, 1_800_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary up to 30 LPA'), S(null, 3_000_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Package: INR 18,00,000 per annum'), S(1_800_000, 1_800_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: ₹12,50,000 - ₹18,00,000'), S(1_250_000, 1_800_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: ₹80,000 per month'), S(80_000, 80_000, 'INR', 'month'));
    assert.deepEqual(parseSalary('Compensation: ₹1.2 crore per year'), S(12_000_000, 12_000_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Pay: 25 lakhs INR'), S(2_500_000, 2_500_000, 'INR', 'year'));
  });

  it('reads "Rs" as INR in a job in India, or next to ₹ / INR / LPA; as PKR otherwise', () => {
    assert.deepEqual(parseSalary('Salary: Rs 15 lakh per annum', 'IN'), S(1_500_000, 1_500_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: Rs. 12,00,000 - 18,00,000 per annum', 'IN'), S(1_200_000, 1_800_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary Rs. 350,000/month', 'IN'), S(350_000, 350_000, 'INR', 'month'));
    assert.deepEqual(parseSalary('Salary: Rs 10-14 LPA'), S(1_000_000, 1_400_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: Rs 90,000 per month (₹10.8 lakh a year)'), S(90_000, 90_000, 'INR', 'month'));
    assert.deepEqual(parseSalary('Salary Rs. 350,000/month'), S(350_000, 350_000, 'PKR', 'month'));
    assert.deepEqual(parseSalary('Salary Rs. 350,000/month', 'RM'), S(350_000, 350_000, 'PKR', 'month'));
    // Pakistani postings use lakh too: "Rs" with a lakh alone stays PKR.
    assert.deepEqual(parseSalary('Salary: Rs 2 lakh per month'), S(200_000, 200_000, 'PKR', 'month'));
    assert.deepEqual(parseSalary('Salary: PKR 3-4 lakh per month', 'IN'), S(300_000, 400_000, 'PKR', 'month'));
  });

  it('takes a bare lakh as INR only in a job in India, and reads it per year there', () => {
    assert.deepEqual(parseSalary('CTC 15 lakhs', 'IN'), S(1_500_000, 1_500_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: 8 - 12 lakh', 'IN'), S(800_000, 1_200_000, 'INR', 'year'));
    assert.equal(parseSalary('CTC 15 lakhs'), null);
  });

  it('ignores rupee amounts that are not pay, or not plausible', () => {
    for (const text of [
      'We raised ₹50 crore in our Series A',
      '₹50 lakh in funding from local investors',
      'Annual learning budget of ₹50,000',
      'Salary: ₹500 per month',
      'Salary: ₹50 crore per year',
      'Salary: Rs 15 lakh per annum', // PKR without a sign it is Indian, and too low for a PKR year
    ])
      assert.equal(parseSalary(text), null, text);
  });

  it('keeps reading Western grouping and other currencies as before', () => {
    assert.deepEqual(parseSalary('Salary: INR 1,500,000 per year'), S(1_500_000, 1_500_000, 'INR', 'year'));
    assert.deepEqual(parseSalary('Salary: $120,000 - $150,000 per year', 'IN'), S(120_000, 150_000, 'USD', 'year'));
  });
});

describe('structuredSalary and parsePayRange: INR', () => {
  it('accepts INR from a source and ₹ / INR in a pay field', () => {
    assert.deepEqual(structuredSalary(1_200_000, 1_800_000, 'inr'), S(1_200_000, 1_800_000, 'INR', 'year'));
    assert.deepEqual(parsePayRange('₹15,00,000.00/yr - ₹25,00,000.00/yr'), S(1_500_000, 2_500_000, 'INR', 'year'));
    assert.deepEqual(parsePayRange('INR 90,000.00/mo'), S(90_000, 90_000, 'INR', 'month'));
  });
});
