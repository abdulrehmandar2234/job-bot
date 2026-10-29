// Auto-fill planning: decides which form field gets which value. Pure logic (no DOM, no chrome.*), so node:test
// covers it. The page side (lib/page-fill.js) describes the fields and applies the plan; it never submits.
//
// Rules: only empty, enabled, visible text fields, textareas, selects and CV file inputs are filled. Checkboxes,
// radios, passwords and anything already filled are left alone. Drafted answers that need the user's input
// ([FILL: ...] or needs_input) are never filled.

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "Abdul Rehman Dar" → { first: "Abdul Rehman", last: "Dar" }. */
export function splitName(full) {
  const parts = String(full ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts.at(-1) };
}

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'checkbox', 'radio', 'search', 'color', 'range']);

// Profile fields, by autocomplete token first, then by the field's label/name/placeholder. Order matters:
// the first rule that matches wins, so "last name" is checked before "name".
const PROFILE_RULES = [
  { key: 'first', auto: ['given-name'], re: /\b(first|given|fore) ?name\b|\bfname\b/ },
  { key: 'last', auto: ['family-name'], re: /\b(last|family|sur) ?name\b|\bsurname\b|\blname\b/ },
  { key: 'email', auto: ['email'], re: /\be ?mail\b/ },
  { key: 'phone', auto: ['tel', 'tel-national'], re: /\b(phone|mobile|cell|telephone|tel|whatsapp)\b/ },
  { key: 'linkedin', auto: [], re: /\blinked ?in\b/ },
  { key: 'location', auto: ['address-level2'], re: /\b(current )?(city|location)\b|\bwhere (are you|do you live)\b/ },
  { key: 'name', auto: ['name'], re: /^(full |your |legal |candidate )?name$|\bfull name\b/ },
  { key: 'cover_letter', auto: [], re: /\bcover ?letter\b|\bmotivation(al)? letter\b/ },
];

const CV_FILE = /\b(resume|cv|curriculum vitae)\b/;

/** The texts that describe a field (label, aria-label, placeholder, name, id), normalized for matching. */
const fieldTexts = (f) => [f.label, f.aria, f.placeholder, f.name, f.id].filter(Boolean).map(norm);

const words = (s) =>
  new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length > 2),
  );

/** Word overlap of a field label and a drafted question, 0–1. */
export function similarity(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size);
}

const usable = (a) => a && !a.needs_input && a.answer && !/\[FILL\b/i.test(a.answer);

/** The option of a select that matches `value` (exact text or value first, then contains), or null. */
export function pickOption(options, value) {
  const v = norm(value);
  if (!v) return null;
  const exact = options.find((o) => norm(o.text) === v || norm(o.value) === v);
  if (exact) return exact.value;
  const loose = options.find((o) => norm(o.text) && (v.startsWith(norm(o.text)) || norm(o.text).includes(v)));
  return loose ? loose.value : null;
}

/**
 * Plans the fill. `fields`: what lib/page-fill.js describeFields() found ({ index, tag, type, label, aria,
 * placeholder, name, id, autocomplete, empty, options }). `data`: { profile, cover_letter, answers, cv }.
 * Returns { fills: [{ index, kind: 'text'|'select'|'file', value, label, source }], skipped: [labels] }.
 */
export function planFill(fields, data) {
  const profile = { ...(data.profile ?? {}), ...splitName(data.profile?.name) };
  if (data.profile?.first) profile.first = data.profile.first;
  if (data.profile?.last) profile.last = data.profile.last;
  profile.cover_letter = data.cover_letter ?? '';
  const answers = (data.answers ?? []).filter(usable);
  const usedAnswers = new Set();
  const fills = [];
  const skipped = [];

  for (const f of fields) {
    const type = String(f.type ?? '').toLowerCase();
    if (SKIP_TYPES.has(type) || !f.empty) continue;
    const texts = fieldTexts(f);
    const matches = (re) => texts.some((t) => re.test(t));
    const label = f.label || f.aria || f.placeholder || f.name || 'field';

    if (type === 'file') {
      if (data.cv && matches(CV_FILE)) fills.push({ index: f.index, kind: 'file', value: data.cv.name, label, source: 'CV' });
      continue;
    }

    const auto = String(f.autocomplete ?? '').toLowerCase();
    const rule = PROFILE_RULES.find((r) => r.auto.includes(auto)) ?? PROFILE_RULES.find((r) => matches(r.re));
    let value = null;
    let source = null;
    if (rule && profile[rule.key] && (rule.key !== 'cover_letter' || f.tag === 'textarea')) {
      value = profile[rule.key];
      source = rule.key === 'cover_letter' ? 'cover letter' : 'profile';
    } else if (!rule) {
      // A drafted answer whose question matches this field's label best.
      let best = null;
      let bestScore = 0.6;
      for (const [i, a] of answers.entries()) {
        if (usedAnswers.has(i)) continue;
        const s = similarity(label, a.question);
        if (s > bestScore || (s === bestScore && !best)) [best, bestScore] = [i, s];
      }
      if (best !== null) {
        value = answers[best].answer;
        source = 'answer';
        usedAnswers.add(best);
      }
    }
    if (value == null) {
      skipped.push(label);
      continue;
    }
    if (f.tag === 'select') {
      const option = pickOption(f.options ?? [], value);
      if (option == null) skipped.push(label);
      else fills.push({ index: f.index, kind: 'select', value: option, label, source });
    } else fills.push({ index: f.index, kind: 'text', value: String(value), label, source });
  }
  return { fills, skipped };
}
