// The CV designs, mirrored from the bot's src/cv/templates/index.ts (the dashboard never imports bot code at run
// time; tests/lib/cv-templates.test.ts checks the two lists match). The bot renders them; the dashboard only names them.

export const TEMPLATES = [
  { id: 'classic', name: 'Classic', description: 'Blue headings with rules, comfortable spacing (the original design).' },
  { id: 'modern', name: 'Modern', description: 'A teal name banner and accent colour; skills as short text lines.' },
  { id: 'compact', name: 'Compact', description: 'Smaller font and tighter spacing, to fit more on one page.' },
] as const;
export type TemplateId = (typeof TEMPLATES)[number]['id'];
export const DEFAULT_TEMPLATE: TemplateId = 'classic';

export const isTemplate = (v: unknown): v is TemplateId => TEMPLATES.some((t) => t.id === v);
export const templateName = (id: TemplateId) => TEMPLATES.find((t) => t.id === id)!.name;
