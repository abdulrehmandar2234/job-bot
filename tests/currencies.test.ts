import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { band, CURRENCY_CODES, currencyOf, eurRate, isCurrency, resolveMark, TEXT_CODES } from '../src/currencies.ts';
import { COUNTRIES } from '../src/regions.ts';

const table = JSON.parse(readFileSync(new URL('../src/currencies.json', import.meta.url), 'utf8'));

describe('src/currencies.json', () => {
  it('maps every country to a known ISO 4217 currency with a positive EUR rate', () => {
    for (const [country, code] of Object.entries<string>(table.countries)) {
      assert.match(country, /^[A-Z]{2}$/, country);
      assert.ok(isCurrency(code), `${country} → ${code}`);
    }
    for (const code of CURRENCY_CODES) {
      assert.match(code, /^[A-Z]{3}$/, code);
      assert.ok(eurRate(code) > 0, code);
    }
  });

  it('has a currency for every country the remote rules know (src/regions.ts)', () => {
    for (const country of Object.keys(COUNTRIES)) assert.ok(currencyOf(country), country);
  });

  it('keeps the tuned bands ordered: year above month above hour', () => {
    for (const code of CURRENCY_CODES) {
      const [hour, month, year] = (['hour', 'month', 'year'] as const).map((p) => band(code, p));
      for (const [lo, hi] of [hour, month, year]) assert.ok(lo < hi, code);
      assert.ok(hour[1] < month[1] && month[1] < year[1], code);
    }
  });
});

describe('currencyOf', () => {
  it('finds the currency by ISO country code, in any case', () => {
    assert.equal(currencyOf('IN'), 'INR');
    assert.equal(currencyOf('pk'), 'PKR');
    assert.equal(currencyOf('NL'), 'EUR');
    assert.equal(currencyOf('gb'), 'GBP');
    assert.equal(currencyOf('XX'), null);
    assert.equal(currencyOf(null), null);
  });
});

describe('band', () => {
  it('uses the tuned band where there is one', () => {
    assert.deepEqual(band('INR', 'year'), [300_000, 30_000_000]);
    assert.deepEqual(band('AED', 'month'), [3_000, 100_000]);
  });

  it('converts a fallback band in US dollars for the others', () => {
    // BDT: about 0.0077 EUR, USD 0.92 EUR, so one dollar is about 119.5 taka.
    const [lo, hi] = band('BDT', 'month');
    assert.equal(Math.round(lo), Math.round(250 * (0.92 / 0.0077)));
    assert.equal(Math.round(hi), Math.round(50_000 * (0.92 / 0.0077)));
  });
});

describe('resolveMark', () => {
  it('keeps a mark only one currency writes', () => {
    assert.equal(resolveMark('₹', '', 'PK', 'PK'), 'INR');
    assert.equal(resolveMark('$', '', 'CA', 'CA'), 'USD');
    assert.equal(resolveMark('CA$', '', null, null), 'CAD');
    assert.equal(resolveMark('nope', '', null, null), null);
  });

  it('resolves "Rs" by the job country, then the user country, then the text, then the first in the table', () => {
    assert.equal(resolveMark('Rs', '', 'IN', 'PK'), 'INR');
    assert.equal(resolveMark('Rs.', '', 'NP', null), 'NPR');
    assert.equal(resolveMark('rs', '', 'RM', 'IN'), 'INR');
    assert.equal(resolveMark('Rs', 'Rs 12 LPA', 'RM', 'NL'), 'INR');
    assert.equal(resolveMark('Rs', 'Rs 15 lakh', null, null), 'INR');
    assert.equal(resolveMark('Rs', 'Rs 15,00,000 (₹)', null, null), 'INR');
    assert.equal(resolveMark('Rs', 'Rs 350,000', null, null), 'PKR');
    assert.equal(resolveMark('Rs', 'Rs 350,000', null, null, false), null);
  });

  it('leaves PHP out of the codes read in text', () => {
    assert.ok(!TEXT_CODES.includes('PHP'));
    assert.ok(TEXT_CODES.includes('INR'));
  });
});
