import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cvSchema, type ImportDraft } from '../../src/cv/import.ts';
import { botDataDir } from '@/lib/bot';

// The CV draft `bot cv:import` saved (data/cv-import/draft.json), shown on the Settings page until it is applied or
// discarded. The bot writes and applies it; the dashboard only reads it.

export { IMPORT_TYPES, MAX_IMPORT_BYTES } from '../../src/cv/import.ts';

/** Where the dashboard puts an uploaded CV for the `cv_import` task (src/tasks.ts accepts only this folder). */
export const importDir = () => join(botDataDir(), 'cv-import');

/** The saved draft, or null when there is none; `error` when it exists but cannot be used. */
export function readImportDraft(): { draft: ImportDraft | null; error: string | null } {
  const file = join(importDir(), 'draft.json');
  if (!existsSync(file)) return { draft: null, error: null };
  try {
    const draft = JSON.parse(readFileSync(file, 'utf8')) as ImportDraft;
    const cv = cvSchema.safeParse(draft.cv);
    if (!cv.success) return { draft: null, error: 'The imported draft is not a valid CV. Import the CV again.' };
    return { draft: { ...draft, cv: cv.data, dropped: draft.dropped ?? [], warnings: draft.warnings ?? [] }, error: null };
  } catch (e) {
    return { draft: null, error: `The imported draft cannot be read (${(e as Error).message}). Import the CV again.` };
  }
}
