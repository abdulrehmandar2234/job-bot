import { mkdirSync } from 'node:fs';
import { config, path } from '../config.ts';
import type { Cv } from '../cv/render.ts';
import { renderPdf } from '../cv/render.ts';
import { isTemplate, TEMPLATE_IDS, TEMPLATES, templateHtml } from '../cv/templates/index.ts';
import { masterRaw } from '../cv/versions.ts';
import type { Flags } from './shared.ts';

// The CV template commands that need no database: listing the designs and previewing one.

/** cv:templates: lists the CV templates and which one is the default (config.json cvTemplate). */
export function cvTemplates() {
  const fallback = config.cvTemplate ?? 'classic';
  for (const t of Object.values(TEMPLATES))
    console.log(`${t.id.padEnd(8)} ${t.name.padEnd(8)} ${t.description}${t.id === fallback ? '  (default)' : ''}`);
  console.log('\nSet the default with config.json "cvTemplate", one job\'s with: npm run bot -- cv:template <id> <template>');
}

/**
 * cv:preview <template> [--pdf]: the master CV in a template, to see a design before choosing it. Prints the HTML,
 * or with --pdf prints it to data/previews/<template>.pdf and prints that path. No database, no CV version.
 */
export async function cvPreview(args: string[], flags: Flags) {
  const template = args[0];
  if (!isTemplate(template)) {
    console.error(`Usage: cv:preview <template> [--pdf], where <template> is one of: ${TEMPLATE_IDS.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const cv = JSON.parse(masterRaw()) as Cv;
  if (!flags.pdf) {
    process.stdout.write(templateHtml(template, cv));
    return;
  }
  const dir = path('data', 'previews');
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${template}.pdf`;
  await renderPdf(cv, file, template);
  console.log(`PDF        : ${file}`);
}
