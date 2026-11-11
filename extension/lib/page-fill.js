// Run inside the job page (chrome.scripting.executeScript) when the user clicks "Fill this form" in the side panel.
// describeFields() lists the form fields; applyFill() types the planned values (lib/fill.js) into empty fields and
// marks them. Neither ever clicks a button or submits a form: the user checks everything and submits.
// Both must stay self-contained (no imports, no closures): Chrome serializes each function on its own.

/** Lists visible, enabled form fields, tagging each with data-jobbot-field so applyFill() can find it again. */
export function describeFields() {
  // An element is shown when neither it nor an ancestor is display:none, visibility:hidden or (near-)transparent,
  // and it has a real box inside the page. A hostile page can plant "email" / "cv" fields hidden with opacity:0,
  // zero size or left:-9999px to harvest values from one honest click, so all of those count as hidden here.
  // (Test environments without layout report a 0×0 page; the box checks are skipped there.)
  const shown = (el) => {
    for (let n = el; n instanceof Element; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const opacity = Number.parseFloat(s.opacity);
      if (!Number.isNaN(opacity) && opacity < 0.1) return false;
    }
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const d = document.documentElement;
    const pageW = Math.max(d.scrollWidth, d.clientWidth, window.innerWidth || 0);
    const pageH = Math.max(d.scrollHeight, d.clientHeight, window.innerHeight || 0);
    const left = r.left + (window.scrollX || 0); // document coordinates
    const top = r.top + (window.scrollY || 0);
    if (pageW > 0 && (left + r.width <= 0 || left >= pageW)) return false;
    if (pageH > 0 && (top + r.height <= 0 || top >= pageH)) return false;
    return true;
  };
  // A file input is often display:none behind a styled "Upload" button; that is fine only when the user can see
  // its trigger (a label). A hidden file input with no visible label never gets the CV.
  const visible = (el) => {
    if (shown(el)) return true;
    if (el.type !== 'file') return false;
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = byFor ?? el.closest('label');
    if (label && shown(label)) return true;
    const by = el.getAttribute('aria-labelledby') ?? '';
    return by.split(/\s+/).some((id) => {
      const n = document.getElementById(id);
      return n != null && shown(n);
    });
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
  // An autocomplete input (react-select on Greenhouse and Ashby, Workday's search fields) is never typed into:
  // text there chooses no option. It is listed, so the panel can say "pick from the list".
  const isCombo = (el) => {
    if (el.tagName === 'SELECT') return false;
    const auto = el.getAttribute('aria-autocomplete');
    return (
      el.getAttribute('role') === 'combobox' ||
      (auto != null && auto !== 'none') ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.closest('[role="combobox"]') != null
    );
  };
  // react-select shows the chosen option next to its (then empty) input, inside the widget: the ancestors that hold
  // no other form field.
  const CHOSEN = '[class*="ingleValue"], [class*="ingle-value"], [class*="ultiValue"], [class*="ulti-value"]';
  const comboEmpty = (el) => {
    if (el.value.trim()) return false;
    let n = el.parentElement;
    for (let depth = 0; n && depth < 4; depth++, n = n.parentElement) {
      if (n.querySelectorAll('input, select, textarea').length > 1) break;
      if (n.querySelector(CHOSEN)) return false;
    }
    return true;
  };
  // The question a custom control answers: its label, aria-label, or the nearest label-like element around it.
  const rawLabelOf = (el) => {
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = byFor ?? el.closest('label');
    if (label) return { text: textOf(label), node: label };
    const by = el.getAttribute('aria-labelledby');
    if (by)
      return {
        text: by
          .split(/\s+/)
          .map((id) => textOf(document.getElementById(id)))
          .join(' '),
        node: null,
      };
    const aria = el.getAttribute('aria-label');
    if (aria) return { text: aria, node: null };
    let n = el.parentElement;
    for (let depth = 0; n && depth < 4; depth++, n = n.parentElement) {
      const near = [...n.querySelectorAll('label, legend, [class*="label"], [class*="Label"], [class*="question"]')].find(
        (x) => !x.contains(el) && !el.contains(x),
      );
      if (near) return { text: textOf(near), node: near };
    }
    return { text: '', node: null };
  };
  const clean = (t) => t.replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  const required = (el, raw) =>
    el.getAttribute('aria-required') === 'true' ||
    el.required === true ||
    /\*|\brequired\b/i.test(raw.text) ||
    /required/i.test(String(raw.node?.className ?? ''));
  // Tags from an earlier run (a previous step of a multi-step form) must not be found again by applyFill().
  for (const old of document.querySelectorAll('[data-jobbot-field]')) old.removeAttribute('data-jobbot-field');
  const els = [...document.querySelectorAll('input, textarea, select')].filter((el) => !el.disabled && !el.readOnly && visible(el));
  const fields = els.map((el, index) => {
    el.setAttribute('data-jobbot-field', String(index));
    const combo = isCombo(el);
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
      empty:
        el.type === 'file' ? el.files.length === 0 : el.tagName === 'SELECT' ? emptySelect(el) : combo ? comboEmpty(el) : !el.value.trim(),
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, text: o.text.trim() })) : [],
      ...(combo && { combobox: true }),
    };
  });

  // Custom controls that are not form fields at all: they are only listed (never clicked), and only when required.
  const customs = new Map();
  const listboxPopup = (el) =>
    el.id && document.querySelector(`[aria-controls="${CSS.escape(el.id)}"], [aria-owns="${CSS.escape(el.id)}"]`);
  for (const el of document.querySelectorAll('[role="listbox"], [role="radiogroup"]')) {
    if (el.closest('[data-jobbot-field]') || listboxPopup(el)) continue;
    const answered = el.querySelector('[aria-selected="true"], [aria-checked="true"], input:checked') != null;
    customs.set(el, { custom: el.getAttribute('role'), empty: !answered });
  }
  // Workday's dropdowns are buttons that open a list; "Select One" means nothing is chosen yet.
  for (const el of document.querySelectorAll('button[aria-haspopup="listbox"]')) {
    const text = textOf(el).replace(/\s+/g, ' ').trim();
    customs.set(el, { custom: 'dropdown', empty: text === '' || /^(-+\s*)?(select|choose|please (select|choose))\b/i.test(text) });
  }
  // A Yes/No question made of buttons (Ashby): an element whose children are 2 to 4 short non-submit buttons.
  const NAV = /\b(next|back|previous|continue|save|submit|cancel|apply|upload|attach|remove|delete|add|edit|close|sign|log)\b/i;
  const groups = new Set([...document.querySelectorAll('button')].map((b) => b.parentElement).filter(Boolean));
  for (const g of groups) {
    const kids = [...g.children];
    if (kids.length < 2 || kids.length > 4 || customs.has(g)) continue;
    if (!kids.every((b) => b.tagName === 'BUTTON' && b.getAttribute('type') !== 'submit' && textOf(b).trim().length <= 20)) continue;
    // Step and file buttons ("Back" / "Save and continue", "Upload" / "Remove") are not questions.
    if (kids.some((b) => b.getAttribute('aria-haspopup') || NAV.test(textOf(b)))) continue;
    const picked = kids.some(
      (b) =>
        ['aria-pressed', 'aria-checked', 'aria-selected'].some((a) => b.getAttribute(a) === 'true') ||
        /(active|selected|checked)/i.test(String(b.className)),
    );
    customs.set(g, { custom: 'buttons', empty: !picked });
  }
  let next = fields.length;
  for (const [el, info] of customs) {
    if (!shown(el)) continue;
    const raw = rawLabelOf(el);
    fields.push({
      index: next++,
      tag: el.tagName.toLowerCase(),
      type: 'custom',
      label: clean(raw.text),
      aria: '',
      placeholder: '',
      name: '',
      id: el.id ?? '',
      autocomplete: '',
      empty: info.empty,
      options: [],
      custom: info.custom,
      required: required(el, raw),
    });
  }
  return fields;
}

/**
 * Applies the plan from lib/fill.js planFill(). `cv`: { name, type, base64 } for a CV file input, or null.
 * Values go in through the native setter plus input/change events, so React and Vue forms see them.
 * Returns how many fields were filled.
 */
export function applyFill(fills, cv) {
  // Same visibility checks as describeFields(), duplicated because Chrome serializes each function on its own.
  const shown = (el) => {
    for (let n = el; n instanceof Element; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const opacity = Number.parseFloat(s.opacity);
      if (!Number.isNaN(opacity) && opacity < 0.1) return false;
    }
    if (el.getClientRects().length === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const d = document.documentElement;
    const pageW = Math.max(d.scrollWidth, d.clientWidth, window.innerWidth || 0);
    const pageH = Math.max(d.scrollHeight, d.clientHeight, window.innerHeight || 0);
    const left = r.left + (window.scrollX || 0);
    const top = r.top + (window.scrollY || 0);
    if (pageW > 0 && (left + r.width <= 0 || left >= pageW)) return false;
    if (pageH > 0 && (top + r.height <= 0 || top >= pageH)) return false;
    return true;
  };
  const visible = (el) => {
    if (shown(el)) return true;
    if (el.type !== 'file') return false;
    const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const label = byFor ?? el.closest('label');
    if (label && shown(label)) return true;
    const by = el.getAttribute('aria-labelledby') ?? '';
    return by.split(/\s+/).some((id) => {
      const n = document.getElementById(id);
      return n != null && shown(n);
    });
  };
  // Checked again right before typing: the page may have changed since describeFields(), and a field the user
  // filled in meanwhile, or one that is now hidden or disabled — text, select or file alike — is never touched.
  // Never typed into, whatever the plan says: text in an autocomplete input chooses no option.
  const combo = (el) => {
    if (el.tagName === 'SELECT') return false;
    const auto = el.getAttribute('aria-autocomplete');
    return (
      el.getAttribute('role') === 'combobox' ||
      (auto != null && auto !== 'none') ||
      el.getAttribute('aria-haspopup') === 'listbox' ||
      el.closest('[role="combobox"]') != null
    );
  };
  const stillEmpty = (el) => {
    if (el.disabled || el.readOnly || combo(el) || !visible(el)) return false;
    if (el.type === 'file') return el.files.length === 0;
    if (el.tagName === 'SELECT') {
      const o = el.options[el.selectedIndex];
      return !o || o.value === '' || o.disabled;
    }
    return !el.value.trim();
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
    el.title = 'Filled by Talaash: check it before you submit';
    filled++;
  }
  return filled;
}

/** The src of every iframe on the page, so the panel can ask for access to the sites they come from. */
export function listFrameUrls() {
  return [...document.querySelectorAll('iframe[src]')].map((f) => f.src);
}
