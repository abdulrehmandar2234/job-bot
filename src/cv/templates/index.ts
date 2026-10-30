import type { Cv } from '../render.ts';
import { classicHtml } from './classic.ts';
import { compactHtml } from './compact.ts';
import { modernHtml } from './modern.ts';

// The CV designs. Every template takes the same Cv data and renders one ATS-safe text column; only the look differs.
// The dashboard mirrors the ids and names in web/lib/cv-templates.ts (parity test in web/tests/lib/cv-templates.test.ts).

export const TEMPLATE_IDS = ['classic', 'modern', 'compact'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
/** The template when config.json has no cvTemplate and the job none of its own: the owner's current CV look. */
export const DEFAULT_TEMPLATE: TemplateId = 'classic';

export type CvTemplate = { id: TemplateId; name: string; description: string; html: (cv: Cv) => string };

export const TEMPLATES: Record<TemplateId, CvTemplate> = {
  classic: {
    id: 'classic',
    name: 'Classic',
    description: 'Blue headings with rules, comfortable spacing (the original design).',
    html: classicHtml,
  },
  modern: {
    id: 'modern',
    name: 'Modern',
    description: 'A teal name banner and accent colour; skills as short text lines.',
    html: modernHtml,
  },
  compact: {
    id: 'compact',
    name: 'Compact',
    description: 'Smaller font and tighter spacing, to fit more on one page.',
    html: compactHtml,
  },
};

export const isTemplate = (v: unknown): v is TemplateId => typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);

/** The CV as a complete HTML document in a template. */
export const templateHtml = (id: TemplateId, cv: Cv) => TEMPLATES[id].html(cv);
