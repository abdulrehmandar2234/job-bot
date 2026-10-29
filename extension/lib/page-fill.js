// Run inside the job page (chrome.scripting.executeScript) when the user clicks "Fill this form" in the side panel.
// describeFields() lists the form fields; applyFill() types the planned values (lib/fill.js) into empty fields and
// marks them. Neither ever clicks a button or submits a form: the user checks everything and submits.
// Both must stay self-contained (no imports, no closures): Chrome serializes each function on its own.

/** Lists visible, enabled form fields, tagging each with data-jobbot-field so applyFill() can find it again. */
export function describeFields() {
  const visible = (el) => {
    if (el.type === 'file') return true; // file inputs are often hidden behind a styled "Upload" button
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  };
  const textOf = (node) => (node ? (node.innerText ?? node.textContent ?? '') : '');
  const labelOf = (el) => {
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = byFor ?? el.closest('label');
    const by = el.getAttribute('aria-labelledby');
    const text = label
      ? textOf(label)
      : by
        ? by
            .split(/\s+/)
            .map((id) => textOf(document.getElementById(id)))
            .join(' ')
        : '';
    return text.replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  };
  // A select is empty while its chosen option is a placeholder: no value, or a disabled "Select…" entry.
  const emptySelect = (el) => {
    const o = el.options[el.selectedIndex];
    return !o || o.value === '' || o.disabled;
  };
  // Tags from an earlier run (a previous step of a multi-step form) must not be found again by applyFill().
  for (const old of document.querySelectorAll('[data-jobbot-field]')) old.removeAttribute('data-jobbot-field');
  const els = [...document.querySelectorAll('input, textarea, select')].filter((el) => !el.disabled && !el.readOnly && visible(el));
  return els.map((el, index) => {
    el.setAttribute('data-jobbot-field', String(index));
    return {
      index,
      tag: el.tagName.toLowerCase(),
      type: el.tagName === 'INPUT' ? (el.getAttribute('type') ?? 'text').toLowerCase() : el.tagName.toLowerCase(),
      label: labelOf(el),
      aria: el.getAttribute('aria-label') ?? '',
      placeholder: el.getAttribute('placeholder') ?? '',
      name: el.getAttribute('name') ?? '',
      id: el.id ?? '',
      autocomplete: el.getAttribute('autocomplete') ?? '',
      empty: el.type === 'file' ? el.files.length === 0 : el.tagName === 'SELECT' ? emptySelect(el) : !el.value.trim(),
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: o.text.trim() })) : [],
    };
  });
}

/**
 * Applies the plan from lib/fill.js planFill(). `cv`: { name, type, base64 } for a CV file input, or null.
 * Values go in through the native setter plus input/change events, so React and Vue forms see them.
 * Returns how many fields were filled.
 */
export function applyFill(fills, cv) {
  // Checked again right before typing: the page may have changed since describeFields(), and a field the user
  // filled in meanwhile, or one that is now hidden or disabled, is never touched.
  const stillEmpty = (el) => {
    if (el.disabled || el.readOnly) return false;
    if (el.type === 'file') return el.files.length === 0;
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      return !o || o.value === '' || o.disabled;
    }
    return !el.value.trim() && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
  };
  let filled = 0;
  for (const f of fills) {
    const el = document.querySelector(`[data-jobbot-field="${f.index}"]`);
    if (!el || !stillEmpty(el)) continue;
    if (f.kind === 'file') {
      if (!cv) continue;
      const bytes = Uint8Array.from(atob(cv.base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], cv.name, { type: cv.type }));
      el.files = dt.files;
    } else {
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement;
      Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, f.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '2px solid #f59e0b';
    el.style.outlineOffset = '1px';
    el.title = 'Filled by job-bot: check it before you submit';
    filled++;
  }
  return filled;
}

/** The src of every iframe on the page, so the panel can ask for access to the sites they come from. */
export function listFrameUrls() {
  return [...document.querySelectorAll('iframe[src]')].map((f) => f.src);
}
