import type { Cv } from '../render.ts';
import { attr, contactParts, esc, shortUrl } from './html.ts';

// Denser, to fit more on one page: a smaller font, tighter margins and spacing, the title on the contact line, all
// skills in one paragraph and each project on one line. Same ATS-safe rules: one text column, real text only.

const ACCENT = '#333';

export function compactHtml(cv: Cv): string {
  const section = (title: string, body: string) => `\n  <h2>${title}</h2>\n  ${body}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 8mm 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 8.5pt; line-height: 1.22; color: #111; margin: 0; }
  h1 { font-size: 16pt; margin: 0; letter-spacing: .2px; }
  .contact { font-size: 8.4pt; color: #444; margin-top: 1px; }
  .contact b { color: #111; font-weight: 600; }
  .contact a { color: #111; text-decoration: none; }
  h2 { font-size: 9pt; text-transform: uppercase; letter-spacing: .8px; color: ${ACCENT};
       border-bottom: .8px solid #999; padding-bottom: 1px; margin: 6px 0 3px; }
  p { margin: 0; }
  .skills b { font-weight: 600; }
  .job { margin-bottom: 3px; break-inside: avoid-page; }
  .row { display: flex; justify-content: space-between; gap: 10px; }
  .row b { font-weight: 600; }
  .dates { color: #555; white-space: nowrap; font-size: 8.3pt; }
  ul { margin: 1px 0 0; padding-left: 12px; }
  li { margin-bottom: 0; }
  .proj { margin-bottom: 1px; }
  .proj a { color: #333; text-decoration: none; }
  </style></head><body>
  <h1>${esc(cv.name)}</h1>
  <div class="contact">${[cv.title && `<b>${esc(cv.title)}</b>`, ...contactParts(cv.contact)].filter(Boolean).join(' | ')}</div>
${section('Summary', `<p>${esc(cv.summary)}</p>`)}${
  cv.skills.length
    ? section(
        'Skills',
        `<p class="skills">${cv.skills.map((g) => `<b>${esc(g.group)}:</b> ${g.items.map(esc).join(', ')}`).join('; ')}</p>`,
      )
    : ''
}${section(
  'Work Experience',
  cv.experience
    .map(
      (e) => `<div class="job">
    <div class="row"><span><b>${esc(e.role)}</b>, ${esc(e.company)}${e.location ? `, ${esc(e.location)}` : ''}</span>
    <span class="dates">${esc(e.dates)}</span></div>
    <ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`,
    )
    .join(''),
)}${
  cv.projects.length
    ? section(
        'Projects',
        cv.projects
          .map(
            (p) =>
              `<p class="proj"><b>${esc(p.name)}</b>${p.url ? ` (<a href="${attr(p.url)}">${esc(shortUrl(p.url))}</a>)` : ''}: ${esc(p.text)}</p>`,
          )
          .join(''),
      )
    : ''
}${section(
  'Education',
  cv.education
    .map(
      (e) => `<div class="row"><span><b>${esc(e.school)}</b> — ${esc(e.degree)}</span>
    <span class="dates">${esc(e.dates)}</span></div>`,
    )
    .join(''),
)}
  </body></html>`;
}
