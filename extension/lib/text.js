// Text helpers for job descriptions. Plain functions without DOM or chrome.* calls, so node:test can test them.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•' };

/** Decodes named (common ones) and numeric HTML entities. */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Collapses spaces inside lines and keeps at most one blank line between paragraphs. */
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v  ​]+/g, ' ')
    .split('\n').map((l) => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Turns description HTML into readable text: block tags become line breaks, list items get a bullet.
 * JSON-LD descriptions are sometimes entity-escaped HTML ("&lt;p&gt;"), so that is decoded first.
 */
export function htmlToText(html) {
  let s = String(html ?? '');
  if (/&lt;\/?[a-z]/i.test(s) && !/<\/?[a-z][^>]*>/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr|section|article|header|footer|blockquote)>/gi, '\n')
    .replace(/<(p|div|ul|ol|h[1-6]|tr|section|article|blockquote)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return cleanText(decodeEntities(s));
}
