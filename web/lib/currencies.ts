import { CURRENCY_CODES, currencyOf, eurRate as tableRate, isCurrency, MARKS, resolveMark } from '../../src/currencies.ts';
import type { SalaryCurrency } from '../../src/types.ts';

// The bot's currency table and rules (src/currencies.ts, built from src/currencies.json): country → currency, the
// approximate EUR rates, and which currency a shared mark like "Rs" means. .ts extensions: the bot's tests load
// lib/db.ts, which imports this file, in plain Node.
export { currencyOf, isCurrency };

/** Every currency code, A–Z. */
export const currencyCodes = () => [...CURRENCY_CODES].sort();

/** Approximate euros per unit: good enough to filter and hint, not for accounting. 0 for a code the table lacks. */
export const eurRate = (code: SalaryCurrency) => (isCurrency(code) ? tableRate(code) : 0);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const markRe = (m: string) => new RegExp((/^[A-Za-z]/.test(m) ? '\\b' : '') + esc(m) + (/[A-Za-z]$/.test(m) ? '(?![A-Za-z])' : ''), 'i');
/** Every symbol and word, longest first so "US$" wins over "$". */
const MARK_LIST = [...MARKS.keys()].sort((a, b) => b.length - a.length);

/**
 * The currency a text the user typed names ("AED 25,000", "18 LPA", "Rs 1.5 lakh"), or null. A written code wins; a
 * symbol or word several currencies share ("Rs") is resolved by the bot's resolveMark: the currency of `country`
 * when it writes it, else the one the text points to (its unique symbol or hints such as LPA), else the first in the
 * table. Plain "$" is USD.
 */
export function namedCurrency(text: string, country: string | null | undefined): SalaryCurrency | null {
  // Upper case only: "try" or "all" in a sentence is not a currency.
  const code = CURRENCY_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text));
  if (code) return code;
  const found = MARK_LIST.find((m) => markRe(m).test(text));
  // No mark: LPA is INR on its own; a lakh or crore is read like "Rs" (as the bot does).
  if (!found && /\d\s?lpa\b/i.test(text)) return 'INR';
  const mark = found ?? (/(?<![a-z])(lakhs?|lacs?|crores?)(?![a-z])/i.test(text) ? 'rs' : null);
  return mark ? resolveMark(mark, text, country, null) : null;
}
