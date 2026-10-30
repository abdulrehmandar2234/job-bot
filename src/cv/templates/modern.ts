import type { Cv } from '../render.ts';
import { attr, contactParts, esc, shortUrl } from './html.ts';

// A teal accent and a name banner. Still ATS-safe: one text column, real text only (no images, tables or icons),
// standard section names, and skills as plain text lines with "·" between them so a parser reads every skill.

const ACCENT = '#0f766e';

export function modernHtml(cv: Cv): string {
  const section = (title: string, body: string) => `\n  <h2>${title}</h2>\n  ${body}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 10mm 0; }
  @page :first { margin-top: 0; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Helvetica, Arial, sans-serif; font-size: 9.4pt; line-height: 1.35; color: #1f2933; margin: 0; }
  header { background: ${ACCENT}; color: #fff; padding: 9mm 13mm 6mm; }
  h1 { font-size: 22pt; margin: 0; letter-spacing: .4px; font-weight: 700; }
  .title { font-size: 11.5pt; margin: 2px 0 0; font-weight: 500; opacity: .95; }
  .contact { font-size: 9.2pt; color: #334e4a; padding: 5px 13mm 0; }
  .contact a { color: ${ACCENT}; text-decoration: none; }
  main { padding: 0 13mm; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 1.2px; color: ${ACCENT};
       border-left: 3px solid ${ACCENT}; padding-left: 6px; margin: 11px 0 5px; }
  p { margin: 0; }
  .skills div { margin-bottom: 2px; }
  .skills b { color: ${ACCENT}; font-weight: 600; }
  .job { margin-bottom: 7px; break-inside: avoid-page; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .row b { font-weight: 600; }
  .company { color: ${ACCENT}; font-weight: 600; }
  .dates { color: #52606d; white-space: nowrap; font-size: 9.1pt; }
  ul { margin: 3px 0 0; padding-left: 15px; }
  li { margin-bottom: 1px; }
  li::marker { color: ${ACCENT}; }
  .proj { margin-bottom: 4px; break-inside: avoid; }
  .proj a { color: ${ACCENT}; text-decoration: none; font-size: 9pt; }
  </style></head><body>
  <header>
  <h1>${esc(cv.name)}</h1>
  <div class="title">${esc(cv.title)}</div>
  </header>
  <div class="contact">${contactParts(cv.contact).join(' · ')}</div>
  <main>${section('Summary', `<p>${esc(cv.summary)}</p>`)}${
    cv.skills.length
      ? section(
          'Skills',
          `<div class="skills">${cv.skills.map((g) => `<div><b>${esc(g.group)}:</b> ${g.items.map(esc).join(' · ')}</div>`).join('')}</div>`,
        )
      : ''
  }${section(
    'Work Experience',
    cv.experience
      .map(
        (e) => `<div class="job">
    <div class="row"><span><b>${esc(e.role)}</b> · <span class="company">${esc(e.company)}</span>${e.location ? `, ${esc(e.location)}` : ''}</span>
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
                `<div class="proj"><b>${esc(p.name)}</b>${p.url ? ` — <a href="${attr(p.url)}">${esc(shortUrl(p.url))}</a>` : ''}
    <p>${esc(p.text)}</p></div>`,
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
  </main>
  </body></html>`;
}
