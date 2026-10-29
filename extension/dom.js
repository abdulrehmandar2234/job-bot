// Tiny DOM helpers for the popup and side panel. Text always goes in as text nodes, never as HTML,
// because job data (titles, letters, answers) comes from web pages.

/** h('p', { className: 'x', onclick }, 'text', child) */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** A button that copies `text` and says so for a moment. */
export function copyButton(text, label = 'Copy') {
  const btn = h('button', { type: 'button', className: 'small' }, label);
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => {
      btn.textContent = label;
    }, 1500);
  });
  return btn;
}

export const link = (href, text) => h('a', { href, target: '_blank', rel: 'noreferrer' }, text);
