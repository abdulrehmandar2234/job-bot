// Helpers shared by the CV templates (src/cv/templates/*.ts).

/** Escapes text for HTML element content and double-quoted attributes. */
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Escapes text for a double-quoted attribute value (href). */
export const attr = (s: string) => esc(s).replace(/"/g, '&quot;');

/** A URL as short link text: "github.com/jane/app" for "https://www.github.com/jane/app/". */
export const shortUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

/**
 * The contact line's parts, empty ones left out: phone, email (mailto link), location, LinkedIn (link). Each part is
 * already HTML.
 */
export function contactParts(c: { phone: string; email: string; location: string; linkedin: string }): string[] {
  return [
    c.phone && esc(c.phone),
    c.email && `<a href="mailto:${attr(c.email)}">${esc(c.email)}</a>`,
    c.location && esc(c.location),
    c.linkedin && `<a href="${attr(c.linkedin)}">LinkedIn</a>`,
  ].filter(Boolean) as string[];
}
