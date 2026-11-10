import { chromium } from 'playwright-core';
import { config } from '../config.ts';
import { UserError } from '../errors.ts';
import { classicHtml } from './templates/classic.ts';
import { DEFAULT_TEMPLATE, templateHtml, type TemplateId } from './templates/index.ts';
import { resolveChrome } from './chrome.ts';

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

/** The CV in the classic template (the original design). Other designs: src/cv/templates/. */
export const cvHtml = (cv: Cv): string => classicHtml(cv);

/**
 * A cover letter as a one-page A4 document in the CV's style: the CV's name, title and contact line as the header,
 * then the letter's paragraphs. `letter` is the plain text stored on the job (it already has greeting and signature).
 */
export function letterHtml(cv: Pick<Cv, 'name' | 'title' | 'contact'>, letter: string, date = new Date()): string {
  const c = cv.contact;
  const paragraphs = letter
    .trim()
    .split(/\n\s*\n/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 18mm 20mm; }
  body { font-family: Helvetica, Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1a1a1a; margin: 0; }
  h1 { font-size: 19pt; margin: 0; letter-spacing: .3px; }
  .title { font-size: 11pt; color: #2b4c7e; font-weight: 600; margin: 2px 0 4px; }
  .contact { font-size: 9.3pt; color: #444; padding-bottom: 8px; border-bottom: 1.2px solid #2b4c7e; }
  .contact a { color: #2b4c7e; text-decoration: none; }
  .date { margin: 16px 0 14px; color: #444; }
  p { margin: 0 0 10px; }
  </style></head><body>
  <h1>${esc(cv.name)}</h1>
  <div class="title">${esc(cv.title)}</div>
  <div class="contact">${[
    c.phone,
    c.email && `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`,
    c.location,
    c.linkedin && `<a href="${esc(c.linkedin)}">LinkedIn</a>`,
  ]
    .filter(Boolean)
    .map((x) => (x!.startsWith('<a') ? x : esc(x!)))
    .join(' | ')}</div>
  <div class="date">${esc(day)}</div>
  ${paragraphs}
  </body></html>`;
}

/** Prints HTML to an A4 PDF with the local Chrome (src/cv/chrome.ts: headless shell first, so no Dock icon). */
export async function htmlToPdf(html: string, outFile: string) {
  const executablePath = resolveChrome(config.chromePath);
  if (!executablePath)
    throw new UserError('No Chrome found: run `npx playwright-core install chromium-headless-shell`, or set config.json chromePath');
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outFile, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }
}

/** Prints the CV to an A4 PDF in a template (classic when not given). */
export const renderPdf = (cv: Cv, outFile: string, template: TemplateId = DEFAULT_TEMPLATE) =>
  htmlToPdf(templateHtml(template, cv), outFile);
