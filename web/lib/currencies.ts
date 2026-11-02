import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SalaryCurrency } from '../../src/types';

// The bot's currency table, src/currencies.json: country (ISO 3166) → currency (ISO 4217), and per currency an
// approximate EUR rate and the symbols and words postings write it with. Read as data, like config.json (the dashboard
// never imports bot code at run time), and only when first needed: the bot's tests load db.ts with plain Node. The
// path is resolved then too, like BOT_ROOT in ./bot (web/..), which this file does not import: db.ts loads it early,
// and tests that move the working directory before importing lib/bot would get the real root.
type Entry = { eur: number; symbols?: string[]; words?: string[]; hints?: string };
type Table = { countries: Record<string, SalaryCurrency>; currencies: Record<SalaryCurrency, Entry> };

let table: Table | null = null;
export const currencyTable = (): Table =>
  (table ??= JSON.parse(readFileSync(resolve(process.cwd(), '..', 'src', 'currencies.json'), 'utf8')));

/** Every currency code, A–Z. */
export const currencyCodes = () => Object.keys(currencyTable().currencies).sort();

export const isCurrency = (code: unknown): code is SalaryCurrency => typeof code === 'string' && code in currencyTable().currencies;

/** Approximate euros per unit: good enough to filter and hint, not for accounting. */
export const eurRate = (code: SalaryCurrency) => currencyTable().currencies[code]?.eur ?? 0;

/** The currency of a country (ISO code, any case), or null when the table does not have it. */
export const currencyOf = (country: string | null | undefined): SalaryCurrency | null =>
  (country && currencyTable().countries[country.toUpperCase()]) || null;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markRe = (m: string) => new RegExp((/^[A-Za-z]/.test(m) ? '\\b' : '') + esc(m) + (/[A-Za-z]$/.test(m) ? '(?![A-Za-z])' : ''), 'i');

/**
 * The currency a text names ("AED 25,000", "18 LPA", "Rs 1.5 lakh"), or null. A code wins; a symbol or word several
 * currencies share ("Rs") means the currency of `country` when it writes it, else the one the text points to (its
 * unique symbol or hints such as LPA), else the first in the table: the same order as the bot's resolveMark in
 * src/currencies.ts. Plain "$" is USD.
 */
export function namedCurrency(text: string, country: string | null | undefined): SalaryCurrency | null {
  const { currencies } = currencyTable();
  // Upper case only: "try" or "all" in a sentence is not a currency.
  const code = Object.keys(currencies).find((c) => new RegExp(`\\b${c}\\b`).test(text));
  if (code) return code;
  const marks = Object.entries(currencies)
    .flatMap(([c, e]) => [...(e.symbols ?? []), ...(e.words ?? [])].map((m) => [m, c] as const))
    .sort((a, b) => b[0].length - a[0].length);
  const found = marks.find(([m]) => markRe(m).test(text))?.[0];
  // No mark: LPA is INR on its own; a lakh or crore is read like "Rs" (as the bot does).
  if (!found && /\d\s?lpa\b/i.test(text)) return 'INR';
  const hit = found ?? (/(?<![a-z])(lakhs?|lacs?|crores?)(?![a-z])/i.test(text) ? 'Rs' : null);
  if (!hit) return null;
  const options = marks.filter(([m]) => m.toLowerCase() === hit.toLowerCase()).map(([, c]) => c);
  const own = currencyOf(country);
  if (own && options.includes(own)) return own;
  const pointed = options.find((c) =>
    [
      ...(currencies[c].symbols ?? []).filter((s) => marks.filter(([m]) => m === s).length === 1).map(markRe),
      ...(currencies[c].hints ? [new RegExp(`(?<![a-z])(?:${currencies[c].hints})(?![a-z])`, 'i')] : []),
    ].some((re) => re.test(text)),
  );
  return pointed ?? options[0];
}
