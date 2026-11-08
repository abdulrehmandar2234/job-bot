import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as bot from '../../../src/currencies';
import { BOT_ROOT } from '@/lib/bot';
import { currencyCodes, currencyOf, currencyTable, eurRate, isCurrency, namedCurrency } from '@/lib/currencies';

// lib/currencies.ts reads the bot's src/currencies.json as data, resolving the path from the working directory
// (web/ -> ../src/currencies.json). This pins both that resolution (a wrong cwd assumption fails loudly here) and
// parity with the bot's own src/currencies.ts, like web/tests/lib/market.test.ts does for the profile.

describe('lib/currencies reads the bot currency table', () => {
  it("equals src/currencies.json, found from the dashboard's working directory", () => {
    const table = JSON.parse(readFileSync(join(BOT_ROOT, 'src', 'currencies.json'), 'utf8'));
    expect(currencyTable()).toEqual(table);
    expect(Object.keys(table.currencies).length).toBeGreaterThan(5);
  });

  it('derives the same codes, rates and country currencies as the bot (src/currencies.ts)', () => {
    expect(currencyCodes()).toEqual([...bot.CURRENCY_CODES].sort());
    for (const code of bot.CURRENCY_CODES) {
      expect(isCurrency(code)).toBe(true);
      expect(eurRate(code)).toBe(bot.eurRate(code));
    }
    expect(isCurrency('XXX')).toBe(false);
    for (const country of Object.keys(currencyTable().countries)) {
      expect(currencyOf(country)).toBe(bot.currencyOf(country));
      expect(currencyOf(country.toLowerCase())).toBe(bot.currencyOf(country));
    }
    expect(currencyOf('ZZ')).toBeNull();
  });

  it('resolves shared marks like the bot (resolveMark: own country first, then what the text points to)', () => {
    const cases: [string, string, string | null][] = [
      ['Rs 150,000 per month', 'Rs', 'PK'], // the job country writes "Rs"
      ['Rs 12 lakh per year', 'Rs', null], // "lakh" points to INR
      ['salary in riyal', 'riyal', 'QA'],
      ['salary in riyal', 'riyal', null], // falls back to the first currency in the table
    ];
    for (const [text, mark, country] of cases) {
      expect(namedCurrency(text, country), text).toBe(bot.resolveMark(mark, text, country, null));
    }
    expect(namedCurrency('AED 25,000 monthly', 'AE')).toBe('AED'); // a written code wins outright
    expect(namedCurrency('18 LPA', null)).toBe('INR');
    expect(namedCurrency('no money named', 'AE')).toBeNull();
  });
});
