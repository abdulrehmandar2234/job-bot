import { describe, expect, it } from 'vitest';
import { currencyCodes, currencyOf, eurRate, isCurrency, namedCurrency } from '@/lib/currencies';

// lib/currencies.ts is the bot's currency module (src/currencies.ts) plus what only the dashboard needs: a sorted code
// list for the salary filter, a zero rate for a code the table lacks, and the currency of a salary the user typed.

describe('lib/currencies', () => {
  it('lists the codes A–Z and knows each one', () => {
    const codes = currencyCodes();
    expect(codes.length).toBeGreaterThan(5);
    expect(codes).toEqual([...codes].sort());
    for (const code of codes) expect(isCurrency(code)).toBe(true);
    expect(isCurrency('XXX')).toBe(false);
    expect(currencyOf('ae')).toBe('AED');
    expect(currencyOf('ZZ')).toBeNull();
  });

  it('has a rate for every code, and 0 for one the table lacks (a stale row), instead of throwing', () => {
    expect(eurRate('EUR')).toBe(1);
    for (const code of currencyCodes()) expect(eurRate(code)).toBeGreaterThan(0);
    expect(eurRate('XXX')).toBe(0);
  });

  it('finds the currency a typed salary names, resolving shared marks like the bot', () => {
    expect(namedCurrency('Rs 150,000 per month', 'PK')).toBe('PKR'); // the country writes "Rs"
    expect(namedCurrency('Rs 150,000 per month', 'IN')).toBe('INR');
    expect(namedCurrency('Rs 12 lakh per year', null)).toBe('INR'); // "lakh" points to INR
    expect(namedCurrency('salary in riyal', 'QA')).toBe('QAR');
    expect(namedCurrency('salary in riyal', null)).toBe('SAR'); // the first currency in the table
    expect(namedCurrency('AED 25,000 monthly', 'PK')).toBe('AED'); // a written code wins outright
    expect(namedCurrency('$5k a month', 'AE')).toBe('USD');
    expect(namedCurrency('18 LPA', null)).toBe('INR');
    expect(namedCurrency('2 lakh', 'PK')).toBe('PKR');
    expect(namedCurrency('I will try all offers', 'AE')).toBeNull(); // lower-case "try" / "all" are not codes
    expect(namedCurrency('no money named', 'AE')).toBeNull();
  });
});
