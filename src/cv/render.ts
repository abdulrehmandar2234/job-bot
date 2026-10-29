import { chromium } from 'playwright-core';
import { config } from '../config.ts';

export type Cv = {
  name: string;
  title: string;
  contact: { phone: string; email: string; location: string; linkedin: string };
  summary: string;
  skills: { group: string; items: string[] }[];
  experience: { role: string; company: string; location: string; dates: string; tags: string[]; bullets: string[] }[];
  projects: { name: string; url: string; tags: string[]; text: string }[];
  education: { school: string; degree: string; dates: string }[];
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ATS-friendly single column layout: real text, no tables or images, standard section names.
export function cvHtml(cv: Cv): string {
  const c = cv.contact;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 11mm 13mm; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 9.4pt; line-height: 1.3; color: #1a1a1a; margin: 0; }
  h1 { font-size: 21pt; margin: 0; letter-spacing: .3px; }
  .title { font-size: 11.5pt; color: #2b4c7e; font-weight: 600; margin: 2px 0 4px; }
  .contact { font-size: 9.3pt; color: #444; }
  .contact a { color: #2b4c7e; text-decoration: none; }
  h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 1px; color: #2b4c7e;
       border-bottom: 1.2px solid #2b4c7e; padding-bottom: 2px; margin: 10px 0 5px; }
  p { margin: 0; }
  .skills div { margin-bottom: 2px; }
  .skills b { font-weight: 600; }
  .job { margin-bottom: 6px; break-inside: avoid-page; }
  .row { display: flex; justify-content: space-between; gap: 12px; }
  .row b { font-weight: 600; }
  .dates { color: #555; white-space: nowrap; font-size: 9.3pt; }
  ul { margin: 3px 0 0; padding-left: 15px; }
  li { margin-bottom: 1px; }
  .proj { margin-bottom: 3px; break-inside: avoid; }
  .proj a { color: #2b4c7e; text-decoration: none; font-size: 9pt; }
  </style></head><body>
  <h1>${esc(cv.name)}</h1>
  <div class="title">${esc(cv.title)}</div>
  <div class="contact">${esc(c.phone)} | <a href="mailto:${esc(c.email)}">${esc(c.email)}</a> | ${esc(c.location)} |
    <a href="${esc(c.linkedin)}">LinkedIn</a></div>

  <h2>Summary</h2><p>${esc(cv.summary)}</p>

  <h2>Technical Skills</h2><div class="skills">
  ${cv.skills.map((g) => `<div><b>${esc(g.group)}:</b> ${g.items.map(esc).join(', ')}</div>`).join('')}
  </div>

  <h2>Work Experience</h2>
  ${cv.experience.map((e) => `<div class="job">
    <div class="row"><span><b>${esc(e.role)}</b>, ${esc(e.company)}${e.location ? `, ${esc(e.location)}` : ''}</span>
    <span class="dates">${esc(e.dates)}</span></div>
    <ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`).join('')}

  <h2>Projects</h2>
  ${cv.projects.map((p) => `<div class="proj"><b>${esc(p.name)}</b> — <a href="${esc(p.url)}">${esc(p.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>
    <p>${esc(p.text)}</p></div>`).join('')}

  <h2>Education</h2>
  ${cv.education.map((e) => `<div class="row"><span><b>${esc(e.school)}</b> — ${esc(e.degree)}</span>
    <span class="dates">${esc(e.dates)}</span></div>`).join('')}
  </body></html>`;
}

export async function renderPdf(cv: Cv, outFile: string) {
  const browser = await chromium.launch({ executablePath: config.chromePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(cvHtml(cv), { waitUntil: 'load' });
    await page.pdf({ path: outFile, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}
