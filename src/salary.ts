import type { Job, Salary, SalaryCurrency, SalaryPeriod } from './types.ts';

// Salary ranges in job postings. Conservative on purpose: an amount only counts when it carries a currency, sits near
// salary wording (or is a "k" range), and is plausible for the period. Anything unclear returns null instead of a guess.

const CODES = 'AED|SAR|EUR|USD|GBP|PKR';
const TOKEN = new RegExp(
  String.raw`(?<![\w.,])(?:(?<pre>US\s?\$|\$|€|£|\b(?:${CODES})(?![A-Za-z])|\bRs\.?)\s?)?` +
    String.raw`(?<num>\d{1,3}(?:[,. ']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?<k>\s?[kK](?![a-zA-Z]))?(?:,-)?` +
    String.raw`(?:\s?(?<post>€|(?<![A-Za-z])(?:${CODES})\b|\b[Ee]uros?\b|\b[Dd]irhams?\b|\b[Rr]iyals?\b))?`,
  'g',
);

const CURRENCY: Record<string, SalaryCurrency> = {
  $: 'USD',
  us$: 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  euro: 'EUR',
  euros: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
  aed: 'AED',
  dirham: 'AED',
  dirhams: 'AED',
  sar: 'SAR',
  riyal: 'SAR',
  riyals: 'SAR',
  pkr: 'PKR',
  rs: 'PKR',
  'rs.': 'PKR',
};

// Plausible pay for a developer, per currency and period. Outside these bands the number is something else
// (an allowance, a budget, a funding round) or the period is wrong, so it is ignored.
const BANDS: Record<SalaryCurrency, Record<SalaryPeriod, [number, number]>> = {
  EUR: { year: [20_000, 400_000], month: [1_500, 15_000], hour: [10, 300] },
  USD: { year: [20_000, 600_000], month: [1_000, 19_999], hour: [10, 300] },
  GBP: { year: [20_000, 400_000], month: [1_500, 15_000], hour: [10, 300] },
  AED: { year: [120_000, 2_000_000], month: [3_000, 100_000], hour: [40, 1_000] },
  SAR: { year: [120_000, 2_000_000], month: [3_000, 100_000], hour: [40, 1_000] },
  PKR: { year: [2_500_000, 50_000_000], month: [50_000, 2_000_000], hour: [500, 20_000] },
};

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

type Token = { start: number; end: number; value: number; k: boolean; currency: SalaryCurrency | null; foreign: boolean };

function amount(num: string): number {
  if (/^\d{1,3}([,. ']\d{3})+([.,]\d{1,2})?$/.test(num)) return Number(num.replace(/[.,]\d{1,2}$/, '').replace(/[,. ']/g, ''));
  return Number(num.replace(',', '.'));
}

function tokens(text: string): Token[] {
  return [...text.matchAll(TOKEN)].map((m) => {
    const g = m.groups!;
    const cur = (g.pre ?? g.post)?.toLowerCase().replace(/\s/g, '');
    return {
      start: m.index,
      end: m.index + m[0].length,
      k: !!g.k,
      value: amount(g.num) * (g.k ? 1000 : 1),
      currency: cur ? (CURRENCY[cur] ?? null) : null,
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

const fits = (v: number, cur: SalaryCurrency, p: SalaryPeriod) => v >= BANDS[cur][p][0] && v <= BANDS[cur][p][1];

/** The first salary range in a posting's title or description, or null when there is none (or it is unclear). */
export function parseSalary(text: string): Salary | null {
  const all = tokens(text);
  for (let i = 0; i < all.length; i++) {
    let a = all[i];
    let b: Token | null = null;
    const next = all[i + 1];
    if (next && RANGE_SEP.test(text.slice(a.end, next.start))) b = next;
    const currency = a.currency ?? b?.currency;
    if (!currency || a.foreign || b?.foreign || (b?.currency && a.currency && b.currency !== a.currency)) continue;
    if (b) {
      i++;
      // "AED 20-25k": the k belongs to both ends.
      if (a.k !== b.k && Math.min(a.value, b.value) < 1000) {
        if (!a.k) a = { ...a, value: a.value * 1000 };
        else b = { ...b, value: b.value * 1000 };
      }
    }
    const end = (b ?? a).end;
    const pre = before(text, a.start, 60);
    const post = after(text, end, 30);
    if (NOT_PAY_BEFORE.test(pre) || NOT_PAY_AFTER.test(post)) continue;
    const ranged = !!b && (a.k || b.k);
    const wording = PERIOD.find(([, re]) => re.test(post)) ?? PERIOD.find(([, re]) => re.test(pre));
    if (!wording && !ranged && !SALARY_WORDS.test(before(text, a.start, 100)) && !SALARY_WORDS.test(post)) continue;

    let min: number | null = a.value;
    let max: number | null = b ? b.value : a.value;
    if (!b && UP_TO.test(pre)) min = null;
    else if (!b && (FROM.test(pre) || /^\s*\+/.test(post))) max = null;
    if (min != null && max != null && (min > max || max > min * 4)) continue;
    const values = [min, max].filter((v): v is number => v != null);
    const plausible = (p: SalaryPeriod) => values.every((v) => fits(v, currency, p));
    // Without period wording, the size of the number decides; when two periods fit (or none), it is unclear.
    const period = wording
      ? wording[0]
      : (['year', 'month'] as const).filter(plausible).length === 1
        ? (['year', 'month'] as const).find(plausible)!
        : null;
    if (!period || !plausible(period)) continue;
    return { min: min == null ? null : Math.round(min), max: max == null ? null : Math.round(max), currency, period };
  }
  return null;
}

// Sources whose API gives salary data of its own (see src/sources); `rescore` keeps what they stored.
export const SALARY_SOURCES = ['adzuna', 'himalayas', 'remoteok', 'lever'];

/** A salary from a source's structured fields, or null when they are empty, zero or in another currency. */
export function structuredSalary(min: unknown, max: unknown, currency: unknown, period: SalaryPeriod = 'year'): Salary | null {
  const num = (v: unknown) =>
    (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number(v) > 0 ? Math.round(Number(v)) : null;
  const cur = String(currency ?? '').toUpperCase() as SalaryCurrency;
  const lo = num(min),
    hi = num(max);
  if (!(cur in BANDS) || (lo == null && hi == null)) return null;
  return lo != null && hi != null && lo > hi ? { min: hi, max: lo, currency: cur, period } : { min: lo, max: hi, currency: cur, period };
}

const PAY_CURRENCY: Record<string, SalaryCurrency> = {
  $: 'USD',
  usd: 'USD',
  '€': 'EUR',
  eur: 'EUR',
  '£': 'GBP',
  gbp: 'GBP',
  aed: 'AED',
  sar: 'SAR',
  sr: 'SAR',
  pkr: 'PKR',
  rs: 'PKR',
};
const PAY_PERIOD: Record<string, SalaryPeriod> = { yr: 'year', year: 'year', mo: 'month', month: 'month', hr: 'hour', hour: 'hour' };
const PAY_END = /(\$|€|£|[a-z]{2,3})\s?([\d,]+(?:\.\d+)?)\s?(k)?\s?\/\s?(yr|year|mo|month|hr|hour)\b/gi;

/**
 * A pay range a job site shows in its own field, such as LinkedIn's "Base pay range": "$50.00/mo - $100.00/mo",
 * "SAR 15,000.00/mo", "€60K/yr - €80K/yr". The company entered it, so unlike text in a description it is taken as
 * given (no plausibility bands). Null when it cannot be read or mixes currencies or periods.
 */
export function parsePayRange(text: string | null | undefined): Salary | null {
  const ends = [...(text ?? '').matchAll(PAY_END)].slice(0, 2).map((m) => ({
    currency: PAY_CURRENCY[m[1].toLowerCase()],
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
