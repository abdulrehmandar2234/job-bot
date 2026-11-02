import { readFileSync } from 'node:fs';
import type { SalaryCurrency, SalaryPeriod } from './types.ts';

// Salary currencies, driven by country. src/currencies.json maps each country (ISO 3166-1 alpha-2) to its currency
// (ISO 4217) and gives every currency an approximate EUR rate, the symbols and words postings write it with, and, where
// they were tuned, plausible pay bands. Adding a country is one line under "countries"; a new currency also needs an
// entry under "currencies". The dashboard reads the same file (web/lib/currencies.ts) for its rates and default.

export type Bands = Record<SalaryPeriod, [number, number]>;
type Entry = { eur: number; symbols?: string[]; words?: string[]; hints?: string; textCode?: boolean; bands?: Bands };
type Table = { countries: Record<string, SalaryCurrency>; currencies: Record<SalaryCurrency, Entry> };

const TABLE: Table = JSON.parse(readFileSync(new URL('./currencies.json', import.meta.url), 'utf8'));

/** Every known currency code, in table order (the first currency that writes a shared symbol is its default). */
export const CURRENCY_CODES = Object.keys(TABLE.currencies);

export const isCurrency = (code: unknown): code is SalaryCurrency => typeof code === 'string' && code in TABLE.currencies;

/** The currency of a country (ISO code, any case), or null when the table does not have it. */
export const currencyOf = (country: string | null | undefined): SalaryCurrency | null =>
  (country && TABLE.countries[country.toUpperCase()]) || null;

/** Approximate euros per unit, for comparing salaries (not for accounting). */
export const eurRate = (code: SalaryCurrency) => TABLE.currencies[code].eur;

// A currency without its own bands is checked against these, after converting to US dollars. Wider than the tuned
// bands on purpose: they cover developer pay from Lagos to Zurich, so they only drop numbers that cannot be pay.
const FALLBACK_USD: Bands = { year: [3_000, 600_000], month: [250, 50_000], hour: [2, 300] };

/** Plausible pay for a developer in this currency and period. */
export function band(code: SalaryCurrency, period: SalaryPeriod): [number, number] {
  const own = TABLE.currencies[code].bands;
  if (own) return own[period];
  const perUsd = eurRate('USD') / eurRate(code);
  const [lo, hi] = FALLBACK_USD[period];
  return [lo * perUsd, hi * perUsd];
}

/** Currency codes that count when a posting writes them ("INR 18,00,000"). PHP is left out: it is mostly the language. */
export const TEXT_CODES = CURRENCY_CODES.filter((c) => TABLE.currencies[c].textCode !== false);

/** Symbols and words (lowercase) → the currencies that use them, in table order. */
export const MARKS = new Map<string, SalaryCurrency[]>();
for (const [code, e] of Object.entries(TABLE.currencies)) {
  for (const mark of [...(e.symbols ?? []), ...(e.words ?? [])]) {
    const key = mark.toLowerCase();
    MARKS.set(key, [...(MARKS.get(key) ?? []), code]);
  }
}
/** The symbols, longest first so "US$" wins over "$". */
export const SYMBOLS = [...new Set(Object.values(TABLE.currencies).flatMap((e) => e.symbols ?? []))].sort((a, b) => b.length - a.length);
export const WORDS = [...new Set(Object.values(TABLE.currencies).flatMap((e) => e.words ?? []))];

/**
 * A symbol or word several currencies share ("Rs": PKR, INR, LKR, NPR; "riyal": SAR, QAR) means, in order:
 *   1. the currency of the job's country, when it writes that mark ("Rs" in a job in India is INR);
 *   2. the currency of the user's own country (remote jobs: "Rs" for a candidate in Pakistan is PKR);
 *   3. a currency the text itself points to: its unique symbol or code ("₹", "INR") or its hints ("LPA", "lakh");
 *   4. the first currency in the table that writes it (PKR for "Rs", SAR for "riyal"), unless `fallback` is false.
 * "$" is not shared: plain "$" is always USD, and other dollars only count when written as such ("CA$", "A$").
 */
export function resolveMark(
  mark: string,
  text: string,
  jobCountry: string | null | undefined,
  userCountry: string | null | undefined,
  fallback = true,
): SalaryCurrency | null {
  const options = MARKS.get(mark.toLowerCase());
  if (!options) return null;
  if (options.length === 1) return options[0];
  for (const country of [jobCountry, userCountry]) {
    const own = currencyOf(country);
    if (own && options.includes(own)) return own;
  }
  const pointed = options.find((code) => {
    const e = TABLE.currencies[code];
    const unique = (e.symbols ?? []).filter((s) => MARKS.get(s.toLowerCase())?.length === 1).map(esc);
    const re = [`\\b${code}\\b`, ...unique, ...(e.hints ? [`(?<![a-z])(?:${e.hints})(?![a-z])`] : [])].join('|');
    return new RegExp(re, 'i').test(text);
  });
  return pointed ?? (fallback ? options[0] : null);
}

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
