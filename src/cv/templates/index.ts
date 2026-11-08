import type { Cv } from '../render.ts';
import { classicHtml } from './classic.ts';
import { compactHtml } from './compact.ts';
import { modernHtml } from './modern.ts';

import { TEMPLATE_IDS, TEMPLATE_INFO, type TemplateId } from './list.ts';

// The CV designs. Every template takes the same Cv data and renders one ATS-safe text column; only the look differs.
// Their ids, names and descriptions are in list.ts, which the dashboard imports.
export { DEFAULT_TEMPLATE, isTemplate, TEMPLATE_IDS, templateName, type TemplateId } from './list.ts';

export type CvTemplate = { id: TemplateId; name: string; description: string; html: (cv: Cv) => string };

const HTML: Record<TemplateId, (cv: Cv) => string> = { classic: classicHtml, modern: modernHtml, compact: compactHtml };

export const TEMPLATES = Object.fromEntries(TEMPLATE_IDS.map((id) => [id, { id, ...TEMPLATE_INFO[id], html: HTML[id] }])) as Record<
  TemplateId,
  CvTemplate
>;

/** The CV as a complete HTML document in a template. */
export const templateHtml = (id: TemplateId, cv: Cv) => TEMPLATES[id].html(cv);
