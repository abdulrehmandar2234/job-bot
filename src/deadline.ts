// The application deadline a posting states ("Apply by 30 November 2026", "Closing date: 30/11/2026"). Import-free,
// so the dashboard can use it too. Only a date right after a deadline phrase counts: a start date, a project date or
// "posted on" is never read as a deadline.

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;

// Phrases that put a deadline right after them.
const CUE =
  /\b(application deadline|deadline(?: for applications| to apply| for submission)?|apply (?:by|before|until|no later than)|closing date(?: for applications)?|applications? (?:close|closes|closing|are open until|open until|accepted until|due)|last (?:date|day)(?: to apply| of application| for applications| for submission)?|(?:vacancy|posting|job|position|role|this) closes|open until|accepting applications until)\b/gi;

// Words that may sit between the phrase and the date: "is", "on", ":", a weekday.
const FILLER =
  /^(?:[\s:–—-]|\b(?:is|on|by|the|of|until|before|date|at|midnight|end of day|eod)\b|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b,?)*/i;

const DATES: [RegExp, (m: RegExpMatchArray) => [number | null, number, number]][] = [
  [/^(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => [Number(m[1]), Number(m[2]), Number(m[3])]],
  [
    new RegExp(String.raw`^${DAY}(?:\s+of)?[\s-]+${MONTH},?\s*(\d{4})?\b`, 'i'),
    (m) => [m[3] ? Number(m[3]) : null, month(m[2]), Number(m[1])],
  ],
  [new RegExp(String.raw`^${MONTH}\s+${DAY},?\s*(\d{4})?\b`, 'i'), (m) => [m[3] ? Number(m[3]) : null, month(m[1]), Number(m[2])]],
  // Numeric dates are read day first (most of the world); "11/30/2026" cannot be, so it is read month first.
  [
    /^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})\b/,
    (m) => {
      const [a, b] = [Number(m[1]), Number(m[2])];
      const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return b > 12 && a <= 12 ? [year, a, b] : [year, b, a];
    },
  ],
];

const month = (name: string) => MONTHS[name.toLowerCase().slice(0, 3)] ?? 0;

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function valid(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * The deadline in `text` as "YYYY-MM-DD", or null. A date without a year takes the year of `from` (the posting date,
 * else today), or the next one when that would put it more than a month before `from`. A deadline more than two months
 * before `from` or more than a year after it is a misread and ignored.
 */
export function parseDeadline(text: string, from: Date = new Date()): string | null {
  const base = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  for (const cue of text.matchAll(CUE)) {
    const after = text.slice((cue.index ?? 0) + cue[0].length, (cue.index ?? 0) + cue[0].length + 60);
    const rest = after.replace(FILLER, '');
    for (const [re, parts] of DATES) {
      const m = rest.match(re);
      if (!m) continue;
      const [year, mon, day] = parts(m);
      let y = year ?? from.getUTCFullYear();
      if (year === null && Date.UTC(y, mon - 1, day) < base - 31 * 86_400_000) y++;
      if (!valid(y, mon, day)) break;
      const at = Date.UTC(y, mon - 1, day);
      if (at < base - 62 * 86_400_000 || at > base + 366 * 86_400_000) break;
      return iso(y, mon, day);
    }
  }
  return null;
}

/** Whole days from `today` (local "YYYY-MM-DD") to the deadline: 0 = closes today, negative = passed. */
export function daysLeft(deadline: string, today: string): number {
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Today's local date as "YYYY-MM-DD". */
export const localToday = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
