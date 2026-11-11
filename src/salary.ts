import { band, esc, isCurrency, resolveMark, SYMBOLS, TEXT_CODES, WORDS } from './currencies.ts';
import type { Job, Salary, SalaryCurrency, SalaryPeriod } from './types.ts';

// Salary ranges in job postings. Conservative on purpose: an amount only counts when it carries a currency, sits near
// salary wording (or is a "k" range), and is plausible for the period. Anything unclear returns null instead of a guess.

// Currency marks come from src/currencies.json (see src/currencies.ts): ISO codes ("INR"), symbols ("₹", "Rs", "CA$")
// and words ("dirhams"). A letter mark needs a word boundary; "$" marks are matched whole, longest first.
const mark = (m: string) => (/^[A-Za-z]/.test(m) ? '\\b' : '') + esc(m) + (/[A-Za-z]$/.test(m) ? '(?![A-Za-z])' : '');
const word = (w: string) => `\\b[${w[0].toUpperCase()}${w[0]}]${esc(w.slice(1))}\\b`;
const CODES = TEXT_CODES.join('|');
const PRE = SYMBOLS.map(mark).join('|');
const POST = [...SYMBOLS.filter((m) => !m.includes('$')).map(mark), ...WORDS.map(word)].join('|');
// An amount: Indian grouping ("18,00,000"), thousands groups ("120,000", "4.500") or plain digits, then an optional
// "k" or a South Asian multiplier: lakh / lac (100,000), crore / cr (10,000,000), or LPA ("lakh per annum").
const TOKEN = new RegExp(
  String.raw`(?<![\w.,])(?:(?<pre>${PRE}|\b(?:${CODES})(?![A-Za-z]))\s?)?` +
    String.raw`(?<num>\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d{1,2})?|\d{1,3}(?:[,. ']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)` +
    String.raw`(?:(?<k>\s?[kK](?![a-zA-Z]))|\s?(?<mult>[Ll]akhs?|[Ll]acs?|LPA|lpa|[Cc]rores?|[Cc]r)\b)?(?:,-)?` +
    String.raw`(?:\s?(?<post>${POST}|(?<![A-Za-z])(?:${CODES})\b))?`,
  'g',
);
const MULT: Record<string, number> = { lakh: 1e5, lac: 1e5, lpa: 1e5, crore: 1e7, cr: 1e7 };

const PERIOD: [SalaryPeriod, RegExp][] = [
  ['hour', /\b(per|an?)\s(hour|uur)\b|\/\s?(hour|hr|h|uur)\b|\bhourly\b|\buurtarief/i],
  [
    'month',
    /\b(per|a|each)\s(month|maand)\b|\/\s?(month|mo|maand|mnd)\b|\bmonthly\b|\bp\.?\s?m\b\.?|\bpcm\b|\bmaandelijks|\bmaandsalaris/i,
  ],
  [
    'year',
    /\b(per|a|each)\s(year|annum|jaar)\b|\/\s?(year|yr|y|jaar)\b|\bannual(ly)?\b|\byearly\b|\bp\.?\s?a\b\.?|\bjaarsalaris|\bjaarlijks/i,
  ],
];
const SALARY_WORDS =
  /\b(salary|salaries|compensation|pay|paid|package|base|range|ote|wage|remuneration|salaris|loon|bruto|gross|ctc|earn|income)\b/i;
// The amount belongs to something that is not pay.
const NOT_PAY_BEFORE =
  /\b(bonus|budget|allowance|stipend|fund(ing|ed)?|raised?|revenue|valuation|series [a-e]|arr|turnover|invest\w*|equity|assets|market cap|grants?|reimburs\w*|vouchers?|worth|gmv|spend)\b/i;
const NOT_PAY_AFTER =
  /^\s*(\+\s*)?(signing |annual |yearly |sign-on )?(bonus|budget|allowance|stipend|in (funding|revenue|arr)|funding|revenue|arr|equity|grants?|vouchers?|m|mm|mn|million|bn|b|billion|trillion)\b/i;
const UP_TO = /\b(up to|upto|max(imum)?|tot)\s*$/i;
const FROM = /\b(from|starting at|vanaf|min(imum)?|at least)\s*$/i;
// "$120,000/yr - $150,000/yr": a per-period suffix may sit between the two ends.
const RANGE_SEP = /^\s*(\/\s?(year|yr|y|annum|month|mo|hour|hr|h)\b)?\s*(-|–|—|to|tot|and|en)\s*$/i;

type Token = {
  start: number;
  end: number;
  value: number;
  /** 1, or what a "k", "lakh" or "crore" after the number multiplied it by. */
  mult: number;
  /** "12 LPA": lakh per annum, so the period is a year. */
  lpa: boolean;
  currency: SalaryCurrency | null;
  /** The currency a number without one implies ("12 LPA"); it never overrides a currency the other end names. */
  implied: SalaryCurrency | null;
  foreign: boolean;
};

function amount(num: string): number {
  if (/^\d{1,2}(,\d{2})+,\d{3}(\.\d{1,2})?$/.test(num)) return Number(num.replace(/,/g, ''));
  if (/^\d{1,3}([,. ']\d{3})+([.,]\d{1,2})?$/.test(num)) return Number(num.replace(/[.,]\d{1,2}$/, '').replace(/[,. ']/g, ''));
  return Number(num.replace(',', '.'));
}

function tokens(text: string, country: string | null, home: string | null): Token[] {
  return [...text.matchAll(TOKEN)].map((m) => {
    const g = m.groups!;
    const cur = (g.pre ?? g.post)?.replace(/\s/g, '');
    const unit = g.mult?.toLowerCase().replace(/s$/, '');
    const mult = g.k ? 1000 : unit ? MULT[unit] : 1;
    return {
      start: m.index,
      end: m.index + m[0].length,
      mult,
      lpa: unit === 'lpa',
      value: amount(g.num) * mult,
      currency: !cur ? null : isCurrency(cur) ? cur : resolveMark(cur, text, country, home),
      // Without a currency, LPA is Indian on its own. A lakh or crore is in rupees when the job's or the user's country
      // writes "Rs", or the text points to one (src/currencies.ts, resolveMark).
      implied: unit === 'lpa' ? 'INR' : unit ? resolveMark('rs', text, country, home, false) : null,
      // CA$, A$, S$, HK$...: a dollar, but not a US one.
      foreign: g.pre === '$' && /[A-Za-z]$/.test(text.slice(0, m.index)),
    };
  });
}

/** The clause around an amount: back to the last sentence break, and forward a short way. */
const CLAUSE = /[;!?\n]|\.(?=\s|$)/;
const before = (text: string, i: number, n: number) =>
  text
    .slice(Math.max(0, i - n), i)
    .split(CLAUSE)
    .at(-1)!;
const after = (text: string, i: number, n: number) => text.slice(i, i + n).split(CLAUSE)[0];

// Plausible pay for a developer, per currency and period (src/currencies.ts). Outside its band the number is something
// else (an allowance, a budget, a funding round) or the period is wrong, so it is ignored.
const fits = (v: number, cur: SalaryCurrency, p: SalaryPeriod) => v >= band(cur, p)[0] && v <= band(cur, p)[1];

/**
 * The first salary range in a posting's title or description, or null when there is none (or it is unclear). The job's
 * country (from scoring) and the user's own country (`home`, used for remote jobs) decide what a shared mark such as
 * "Rs" means, see resolveMark in src/currencies.ts.
 */
export function parseSalary(text: string, country: string | null = null, home: string | null = null): Salary | null {
  const all = tokens(text, country, home);
  for (let i = 0; i < all.length; i++) {
    let a = all[i];
    let b: Token | null = null;
    const next = all[i + 1];
    if (next && RANGE_SEP.test(text.slice(a.end, next.start))) b = next;
    const currency = a.currency ?? b?.currency ?? a.implied ?? b?.implied;
    if (!currency || a.foreign || b?.foreign || (b?.currency && a.currency && b.currency !== a.currency)) continue;
    if (b) {
      i++;
      // "AED 20-25k", "12-18 LPA": the k (or lakh) belongs to both ends.
      if (a.mult !== b.mult && Math.min(a.mult, b.mult) === 1 && Math.min(a.value, b.value) < 1000) {
        if (a.mult === 1) a = { ...a, value: a.value * b.mult, mult: b.mult, lpa: b.lpa };
        else b = { ...b, value: b.value * a.mult, mult: a.mult, lpa: a.lpa };
      }
    }
    const end = (b ?? a).end;
    const pre = before(text, a.start, 60);
    const post = after(text, end, 30);
    if (NOT_PAY_BEFORE.test(pre) || NOT_PAY_AFTER.test(post)) continue;
    const ranged = !!b && (a.mult > 1 || b.mult > 1);
    // LPA is per year by definition.
    const said: SalaryPeriod | undefined =
      a.lpa || b?.lpa ? 'year' : (PERIOD.find(([, re]) => re.test(post)) ?? PERIOD.find(([, re]) => re.test(pre)))?.[0];
    if (!said && !ranged && !SALARY_WORDS.test(before(text, a.start, 100)) && !SALARY_WORDS.test(post)) continue;
    // Indian pay quoted in lakh or crore is annual (CTC) unless it says otherwise.
    const lakhs = currency === 'INR' && Math.max(a.mult, b?.mult ?? 1) >= 1e5;
    const wording = said ?? (lakhs ? 'year' : undefined);

    let min: number | null = a.value;
    let max: number | null = b ? b.value : a.value;
    if (!b && UP_TO.test(pre)) min = null;
    else if (!b && (FROM.test(pre) || /^\s*\+/.test(post))) max = null;
    if (min != null && max != null && (min > max || max > min * 4)) continue;
    const values = [min, max].filter((v): v is number => v != null);
    const plausible = (p: SalaryPeriod) => values.every((v) => fits(v, currency, p));
    // Without period wording, the size of the number decides; when two periods fit (or none), it is unclear.
    const period = wording
      ? wording
      : (['year', 'month'] as const).filter(plausible).length === 1
        ? (['year', 'month'] as const).find(plausible)!
        : null;
    if (!period || !plausible(period)) continue;
    return { min: min == null ? null : Math.round(min), max: max == null ? null : Math.round(max), currency, period };
  }
  return null;
}

// Sources whose API gives salary data of its own (see src/sources); `rescore` keeps what they stored.
export const SALARY_SOURCES = ['adzuna', 'himalayas', 'remoteok', 'lever', 'jobicy', 'freehire'];

/** A salary from a source's structured fields, or null when they are empty, zero or in another currency. */
export function structuredSalary(min: unknown, max: unknown, currency: unknown, period: SalaryPeriod = 'year'): Salary | null {
  const num = (v: unknown) =>
    (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number(v) > 0 ? Math.round(Number(v)) : null;
  const cur = String(currency ?? '').toUpperCase() as SalaryCurrency;
  const lo = num(min),
    hi = num(max);
  if (!isCurrency(cur) || (lo == null && hi == null)) return null;
  return lo != null && hi != null && lo > hi ? { min: hi, max: lo, currency: cur, period } : { min: lo, max: hi, currency: cur, period };
}

// A code ("SAR", or LinkedIn's "SR") or a symbol from src/currencies.ts.
const payCurrency = (m: string): SalaryCurrency | null => {
  const code = m.toUpperCase() === 'SR' ? 'SAR' : m.toUpperCase();
  return isCurrency(code) ? code : resolveMark(m, '', null, null);
};
const PAY_PERIOD: Record<string, SalaryPeriod> = { yr: 'year', year: 'year', mo: 'month', month: 'month', hr: 'hour', hour: 'hour' };
const PAY_END = new RegExp(
  String.raw`(${SYMBOLS.map(esc).join('|')}|[a-z]{2,3})\s?([\d,]+(?:\.\d+)?)\s?(k)?\s?\/\s?(yr|year|mo|month|hr|hour)\b`,
  'gi',
);

/**
 * A pay range a job site shows in its own field, such as LinkedIn's "Base pay range": "$50.00/mo - $100.00/mo",
 * "SAR 15,000.00/mo", "€60K/yr - €80K/yr". The company entered it, so unlike text in a description it is taken as
 * given (no plausibility bands). Null when it cannot be read or mixes currencies or periods.
 */
export function parsePayRange(text: string | null | undefined): Salary | null {
  const ends = [...(text ?? '').matchAll(PAY_END)].slice(0, 2).map((m) => ({
    currency: payCurrency(m[1]),
    value: Number(m[2].replace(/,/g, '')) * (m[3] ? 1000 : 1),
    period: PAY_PERIOD[m[4].toLowerCase()],
  }));
  if (!ends.length || ends.some((e) => !e.currency || !(e.value > 0))) return null;
  const [a, b] = ends;
  if (b && (b.currency !== a.currency || b.period !== a.period)) return null;
  return structuredSalary(a.value, b?.value ?? a.value, a.currency, a.period);
}

/** The salary stored on a jobs row, if any. */
export function rowSalary(j: Pick<Job, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>): Salary | null {
  if (!j.salary_currency || !j.salary_period || (j.salary_min == null && j.salary_max == null)) return null;
  return { min: j.salary_min, max: j.salary_max, currency: j.salary_currency, period: j.salary_period };
}
