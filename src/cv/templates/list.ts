// The CV designs by id, name and description: what `cv:templates` and the dashboard's template pickers show. Pure
// data (the renderers are in index.ts), so the dashboard's client components import it too.

export const TEMPLATE_IDS = ['classic', 'modern', 'compact'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
/** The template when config.json has no cvTemplate and the job none of its own: the owner's current CV look. */
export const DEFAULT_TEMPLATE: TemplateId = 'classic';

export const TEMPLATE_INFO: Record<TemplateId, { name: string; description: string }> = {
  classic: { name: 'Classic', description: 'Blue headings with rules, comfortable spacing (the original design).' },
  modern: { name: 'Modern', description: 'A teal name banner and accent colour; skills as short text lines.' },
  compact: { name: 'Compact', description: 'Smaller font and tighter spacing, to fit more on one page.' },
};

/** The designs in order (classic first), for lists and pickers. */
export const TEMPLATE_LIST = TEMPLATE_IDS.map((id) => ({ id, ...TEMPLATE_INFO[id] }));

export const isTemplate = (v: unknown): v is TemplateId => typeof v === 'string' && (TEMPLATE_IDS as readonly string[]).includes(v);
export const templateName = (id: TemplateId) => TEMPLATE_INFO[id].name;
