import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { aiImportCv } from '../ai.ts';
import { config } from '../config.ts';
import { backupDir } from '../cv/confirm-skills.ts';
import { checkImported, cvSchema, draftFile, type ImportDraft, readCvText } from '../cv/import.ts';
import { UserError } from '../errors.ts';
import { masterFile } from '../settings.ts';
import { type Flags, usage } from './shared.ts';

const USAGE = 'cv:import <cv.pdf|cv.docx|cv.txt> [--name original.pdf] | cv:import --apply | cv:import --discard';

/** The saved draft, checked against the master CV's shape, or null when there is none. */
export function readDraft(file = draftFile()): ImportDraft | null {
  if (!existsSync(file)) return null;
  let draft: ImportDraft;
  try {
    draft = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new UserError(`The imported draft ${file} cannot be read (${(e as Error).message}). Import the CV again.`);
  }
  const parsed = cvSchema.safeParse(draft?.cv);
  if (!parsed.success) throw new UserError(`The imported draft ${file} is not a valid CV. Import the CV again.`);
  return { ...draft, cv: parsed.data };
}

/** Writes the draft's CV to cv/master.json, after a backup of the current one; removes the draft. */
export function applyDraft(now = new Date()): { master: string; backup: string | null } {
  const draft = readDraft();
  if (!draft) throw new UserError('There is no imported CV to apply. Import one first: npm run bot -- cv:import <file>');
  const master = masterFile();
  let backup: string | null = null;
  if (existsSync(master)) {
    mkdirSync(backupDir(), { recursive: true });
    backup = join(backupDir(), `master-${now.toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(backup, readFileSync(master));
  }
  mkdirSync(dirname(master), { recursive: true });
  writeFileSync(`${master}.tmp`, `${JSON.stringify(draft.cv, null, 2)}\n`);
  // Replaced in one step, so a crash never leaves a half-written master CV.
  writeFileSync(master, readFileSync(`${master}.tmp`));
  rmSync(`${master}.tmp`, { force: true });
  rmSync(draftFile(), { force: true });
  return { master, backup };
}

/**
 * cv:import <file>: reads a CV (PDF, .docx, .txt, .md), has the AI sort it into the master CV's fields, drops skills
 * the text does not contain, and saves a draft. cv:import --apply makes the draft cv/master.json (after a backup);
 * --discard removes it. Nothing replaces the master CV without --apply.
 */
export async function cvImport(args: string[], flags: Flags) {
  if (flags.discard) {
    rmSync(draftFile(), { force: true });
    return console.log('Imported draft removed. cv/master.json is unchanged.');
  }
  if (flags.apply) {
    const { master, backup } = applyDraft();
    console.log(`Saved as your master CV: ${master}`);
    if (backup) console.log(`The previous one is kept in ${backup}`);
    console.log('Next: npm run bot -- cv:default (your CV as a PDF), then npm run bot -- rescore');
    return;
  }
  const file = args[0];
  if (!file) return usage(USAGE);
  if (!config.ai.enabled) throw new UserError('Importing a CV needs the AI, and it is off (config.json ai.enabled).');
  const text = await readCvText(file);
  const parsed = cvSchema.safeParse(await aiImportCv(text));
  if (!parsed.success) throw new UserError(`The AI did not return a complete CV (${parsed.error.issues[0]?.message}). Try again.`);
  const { cv, dropped, warnings } = checkImported(parsed.data, text);
  const source = flags.name && flags.name !== 'true' ? basename(flags.name) : basename(file);
  const draft: ImportDraft = { source, created_at: new Date().toISOString(), cv, dropped, warnings };
  mkdirSync(dirname(draftFile()), { recursive: true });
  writeFileSync(draftFile(), `${JSON.stringify(draft, null, 2)}\n`);

  const skills = cv.skills.reduce((n, g) => n + g.items.length, 0);
  console.log(`Read ${source}: ${cv.name}${cv.title ? `, ${cv.title}` : ''}`);
  console.log(
    `Found      : ${cv.experience.length} jobs, ${skills} skills, ${cv.projects.length} projects, ${cv.education.length} education`,
  );
  if (dropped.length) console.log(`Left out   : ${dropped.join(', ')} (not in your CV's text)`);
  for (const w of warnings) console.log(`Check      : ${w}`);
  console.log(`Draft      : ${draftFile()}`);
  console.log('Read the draft and fix anything that is wrong, then: npm run bot -- cv:import --apply');
}
