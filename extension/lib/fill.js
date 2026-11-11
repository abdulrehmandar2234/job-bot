// Auto-fill planning: decides which form field gets which value. Pure logic (no DOM, no chrome.*), so node:test
// covers it. The page side (lib/page-fill.js) describes the fields and applies the plan; it never submits.
//
// Rules: only empty, enabled, visible text fields, textareas, selects and CV file inputs are filled. Checkboxes,
// radios, passwords and anything already filled are left alone. Drafted answers that need the user's input
// ([FILL: ...] or needs_input) are never filled. Custom dropdowns are never typed into: an autocomplete input
// (role=combobox, aria-autocomplete) would look filled while no option is chosen. Those, and required custom
// controls (Workday's button dropdowns, ARIA listboxes and radio groups, Ashby's Yes/No buttons), are listed under
// "Left for you" as "pick from the list" instead, so the form never looks complete when it is not.

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "Sara Ann Khan" → { first: "Sara Ann", last: "Khan" }. */
export function splitName(full) {
  const parts = String(full ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return { first: parts[0] ?? '', last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts.at(-1) };
}

const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image', 'password', 'checkbox', 'radio', 'search', 'color', 'range']);

// Profile fields, by autocomplete token first, then by a short label (or, with no visible label, the name/id
// attribute). Order matters: the first rule that matches wins, so "last name" is checked before "name".
const PROFILE_RULES = [
  { key: 'first', auto: ['given-name'], re: /\b(first|given|fore) ?name\b|\bfname\b/ },
  { key: 'last', auto: ['family-name'], re: /\b(last|family|sur) ?name\b|\bsurname\b|\blname\b/ },
  { key: 'email', auto: ['email'], re: /\be ?mail\b/ },
  { key: 'phone', auto: ['tel', 'tel-national'], re: /\b(phone|mobile|cell|telephone|tel|whatsapp)\b/ },
  { key: 'linkedin', auto: [], re: /\blinked ?in\b/ },
  { key: 'location', auto: ['address-level2'], re: /\b(current )?(city|location)\b/ },
  { key: 'name', auto: ['name'], re: /^(full |your |legal |candidate )?name$|\bfull name\b/ },
  { key: 'cover_letter', auto: [], re: /\bcover ?letter\b|\bmotivation(al)? letter\b/ },
];

const CV_FILE = /\b(resume|cv|curriculum vitae)\b/;

// Labels about someone else, or about a preference, never get the candidate's own details:
// "Referrer full name", "Emergency contact phone", "Company name", "Preferred work location".
const NOT_PROFILE = /\b(refer\w*|reference|emergency|company|employer|hear|heard|preferred|desired)\b/;

/** At most this many words and no "?": a label like "Mobile number", not a question that mentions "mobile". */
const MAX_PROFILE_LABEL_WORDS = 5;

/**
 * The texts a profile rule may look at. Visible texts (label, aria-label, placeholder) count when they are short
 * labels; the name/id attributes only when the field has no visible text at all (an id="name" next to the label
 * "Company name" must not get the candidate's name).
 */
function profileTexts(f) {
  const visible = [f.label, f.aria, f.placeholder].filter(Boolean);
  const texts = visible.length ? visible : [f.name, f.id].filter(Boolean);
  return texts
    .filter((t) => !t.includes('?'))
    .map(norm)
    .filter((t) => t.split(' ').length <= MAX_PROFILE_LABEL_WORDS && !NOT_PROFILE.test(t));
}

// Words too common to say two questions are the same ("Are you a citizen?" vs "Are you willing to relocate?").
const STOP_WORDS = new Set(
  'a an and are as at be by can could did do does for from had has have how i if in is it me my of on or our please should so than that the their them there they this to us was we were what when where which who why will with would you your'.split(
    ' ',
  ),
);
const words = (s) =>
  new Set(
    norm(s)
      .split(' ')
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );

/** Content-word overlap of a field label and a drafted question, 0–1 (shared words over the larger set). */
export function similarity(a, b) {
  const [x, y] = [words(a), words(b)];
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.max(x.size, y.size);
}

const usable = (a) => a && !a.needs_input && a.answer && !/\[FILL\b/i.test(a.answer);

/** Loose option matching needs at least this many characters: "No" must never pick "Norway" by containment. */
const MIN_CONTAINS_LENGTH = 3;

/**
 * The option of a select that matches `value`: exact text or value first, then an option whose text is the
 * value's first whole words ("Yes, within a month" → "Yes", but "Notice period…" never → "No"), or whose text
 * contains the value as whole words ("United Arab Emirates" → "United Arab Emirates (UAE)"). The contains rule
 * is word-bounded and needs a value of 3+ characters, so a short answer only ever matches an option exactly.
 */
export function pickOption(options, value) {
  const v = norm(value);
  if (!v) return null;
  const exact = options.find((o) => norm(o.text) === v || norm(o.value) === v);
  if (exact) return exact.value;
  const loose = options.find((o) => {
    const t = norm(o.text);
    if (!t) return false;
    if (v.startsWith(`${t} `)) return true;
    return v.length >= MIN_CONTAINS_LENGTH && ` ${t} `.includes(` ${v} `);
  });
  return loose ? loose.value : null;
}

/**
 * Plans the fill. `fields`: what lib/page-fill.js describeFields() found ({ index, tag, type, label, aria,
 * placeholder, name, id, autocomplete, empty, options }). `data`: { profile, cover_letter, answers, cv }.
 * Returns { fills: [{ index, kind: 'text'|'select'|'file', value, label, source }], skipped: [labels] }.
 * `usedAnswers` carries the drafted answers already planned elsewhere (another frame of the same page), so an
 * answer is typed into one field on the whole page; planFrameFills() passes it between frames.
 */
export function planFill(fields, data, usedAnswers = new Set()) {
  const profile = { ...(data.profile ?? {}), ...splitName(data.profile?.name) };
  if (data.profile?.first) profile.first = data.profile.first;
  if (data.profile?.last) profile.last = data.profile.last;
  profile.cover_letter = data.cover_letter ?? '';
  const answers = (data.answers ?? []).filter(usable);
  const fills = [];
  const skipped = [];

  for (const f of fields) {
    const type = String(f.type ?? '').toLowerCase();
    if (SKIP_TYPES.has(type) || !f.empty) continue;
    const all = [f.label, f.aria, f.placeholder, f.name, f.id].filter(Boolean).map(norm);
    const short = profileTexts(f);
    const label = f.label || f.aria || f.placeholder || f.name || 'field';

    if (f.combobox || f.custom) {
      if (f.combobox || f.required) skipped.push(`${label} (pick from the list)`);
      continue;
    }

    if (type === 'file') {
      if (data.cv && all.some((t) => CV_FILE.test(t)))
        fills.push({ index: f.index, kind: 'file', value: data.cv.name, label, source: 'CV' });
      continue;
    }

    const auto = String(f.autocomplete ?? '').toLowerCase();
    const rule = PROFILE_RULES.find((r) => r.auto.includes(auto)) ?? PROFILE_RULES.find((r) => short.some((t) => r.re.test(t)));
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
        if (s > bestScore || (s === bestScore && best === null)) [best, bestScore] = [i, s];
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

/**
 * What the fill may use for a job from the lookup (`j`): its profile, cover letter, drafted answers and CV name.
 * `profileOnly` (a page with no known job: "Fill profile + CV only") keeps the profile and the CV and drops the
 * letter and the answers, which belong to one job.
 */
export function fillData(j, { profileOnly = false } = {}) {
  return {
    profile: j?.profile ?? {},
    cover_letter: profileOnly ? '' : (j?.cover_letter ?? ''),
    answers: profileOnly ? [] : (j?.form_answers ?? []),
    cv: j?.cv_url ? { name: j.cv_file_name } : null,
  };
}

/**
 * The result lines of a fill, as data so the side panel can keep them for the tab (lib/tab-memory.js) and show them
 * again on the next step of a form: [{ text, kind: 'plain' | 'needs' | 'hint' }].
 * `result`: { filled: [labels], skipped: [labels], needInput: number of drafted answers that need the user }.
 * @param {{ filled?: string[], skipped?: string[], needInput?: number }} [result]
 */
export function fillSummary({ filled = [], skipped = [], needInput = 0 } = {}) {
  const left = [...new Set(skipped)];
  const lines = [];
  if (filled.length) lines.push({ text: `Filled ${filled.length} fields (outlined in orange): ${filled.join(', ')}.`, kind: 'plain' });
  else lines.push({ text: 'No empty fields here that Talaash knows how to fill.', kind: 'plain' });
  if (left.length) lines.push({ text: `Left for you: ${left.join(', ')}.`, kind: 'needs' });
  if (needInput > 0) lines.push({ text: `${needInput} drafted answers need your input, so they were not filled.`, kind: 'needs' });
  if (filled.length || left.length) lines.push({ text: 'Check every field, then submit the form yourself.', kind: 'hint' });
  return lines;
}

/**
 * Plans the fill for every frame of a page in one pass (`frames`: one describeFields() result per frame), sharing
 * the used-answer bookkeeping, so a drafted answer goes into one field across all frames, not once per frame.
 * Profile values are not single-use: a form split over frames may legitimately ask for the email twice.
 * Returns one { fills, skipped } plan per frame, in the same order.
 * @param {ReadonlyArray<object[] | null>} frames one describeFields() result per frame (null: frame not readable)
 * @param {object} data what the side panel prepared ({ profile, cover_letter, answers, cv })
 */
export function planFrameFills(frames, data) {
  const used = new Set();
  return frames.map((fields) => planFill(fields ?? [], data, used));
}
