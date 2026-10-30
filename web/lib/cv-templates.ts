import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOT_ROOT } from './bot';
import { configFile, readConfig } from './settings';
import { DEFAULT_TEMPLATE, isTemplate, type TemplateId } from './cv-template-list';

// Server-side helpers for the CV files and templates: the PDF path and file name, the default template from
// config.json, and a version's template and feedback note from its meta.json. The list itself is in cv-template-list.ts, which client components can import too.

export { DEFAULT_TEMPLATE, isTemplate, TEMPLATES, templateName, type TemplateId } from './cv-template-list';

/**
 * config.json cvFileName, from the file the bot uses (JOB_BOT_CONFIG when set). It lives here, not in bot.ts, because
 * settings.ts imports bot.ts.
 */
export function cvFileName(): string {
  return JSON.parse(readFileSync(configFile(), 'utf8')).cvFileName;
}

/** The PDF of a CV version ("default" is the untouched original). */
export function cvPath(version: string) {
  return version === 'default' ? join(BOT_ROOT, 'cv', 'default', cvFileName()) : join(BOT_ROOT, 'cv', 'versions', version, cvFileName());
}

/** config.json cvTemplate (the default for jobs without one of their own), else classic. */
export function defaultTemplate(): TemplateId {
  const value = readConfig().data?.cvTemplate;
  return isTemplate(value) ? value : DEFAULT_TEMPLATE;
}

/**
 * What a CV version's meta.json says: the template it was rendered in (classic for "default" and versions made before
 * templates), and for a CV revised with feedback, what the AI and the master-CV check left out.
 */
export function versionInfo(version: string): { template: TemplateId; feedbackNote: string[] } {
  const none = { template: DEFAULT_TEMPLATE, feedbackNote: [] };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(version) || version === 'default') return none;
  const file = join(BOT_ROOT, 'cv', 'versions', version, 'meta.json');
  try {
    const meta = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    return {
      template: isTemplate(meta.template) ? meta.template : DEFAULT_TEMPLATE,
      feedbackNote: Array.isArray(meta.feedbackNote) ? meta.feedbackNote.filter((n: unknown) => typeof n === 'string') : [],
    };
  } catch {
    return none;
  }
}
