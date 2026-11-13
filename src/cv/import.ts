// `bot cv:import <file>`: turns an existing CV (PDF, Word .docx, or plain text) into cv/master.json. The text is read
// here, the AI only re-arranges it into the master CV's fields, and checkImported() then drops any skill the text does
// not contain, so the draft never holds a skill the CV did not state. The draft is saved apart (data/cv-import) and
// only replaces cv/master.json when the user applies it, after a backup.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';
import { UserError } from '../errors.ts';
import { dataPath } from '../settings.ts';
import type { Cv } from './render.ts';

/** Where the draft waits until it is applied or discarded. */
export const draftFile = () => dataPath('cv-import', 'draft.json');
/** Files the dashboard and the CLI accept. */
export const IMPORT_TYPES = ['.pdf', '.docx', '.txt', '.md'] as const;
/** Larger files are refused before they are read. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
/** A CV with less text than this is probably a scanned image: there is nothing to import. */
export const MIN_TEXT = 200;

const str = z.string();
const tags = z.array(str);
/** The master CV's shape (src/cv/render.ts Cv), checked before a draft is saved or applied. */
export const cvSchema: z.ZodType<Cv> = z.object({
  name: z.string().min(1),
  title: str,
  contact: z.object({ phone: str, email: str, location: str, linkedin: str }),
  summary: str,
  skills: z.array(z.object({ group: z.string().min(1), items: z.array(z.string().min(1)) })),
  experience: z.array(z.object({ role: str, company: str, location: str, dates: str, tags, bullets: z.array(z.string().min(1)) })),
  projects: z.array(z.object({ name: str, url: str, tags, text: str })),
  education: z.array(z.object({ school: str, degree: str, dates: str })),
});

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(Number.parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10)) : (ENTITIES[e] ?? m),
  );

/** One file of a zip archive (a .docx is one), or null when it is not there. Stored and deflated entries only. */
export function unzipEntry(zip: Buffer, name: string): Buffer | null {
  // The end-of-central-directory record is in the last 64 KB (its comment is at most 65535 bytes).
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--)
    if (zip.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) return null;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count && zip.readUInt32LE(at) === 0x02014b50; n++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const skip = nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    at += 46 + skip;
  }
  return null;
}

/** The text of a Word .docx: one line per paragraph, tabs and line breaks kept. */
export function docxText(file: Buffer): string {
  const xml = unzipEntry(file, 'word/document.xml');
  if (!xml) throw new UserError('This .docx file has no document text (word/document.xml). Save it again from Word, or export a PDF.');
  return decode(
    xml
      .toString('utf8')
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>|<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The text of a CV file, by its extension. Throws a UserError for a type it cannot read or a file with no text. */
export async function readCvText(file: string): Promise<string> {
  const ext = extname(file).toLowerCase();
  if (!(IMPORT_TYPES as readonly string[]).includes(ext))
    throw new UserError(`Cannot import a ${ext || 'file without an extension'}: use one of ${IMPORT_TYPES.join(', ')}.`);
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (e) {
    throw new UserError(`Cannot read ${file}: ${(e as Error).message}`);
  }
  if (buf.length > MAX_IMPORT_BYTES) throw new UserError(`${file} is larger than ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`);
  let text: string;
  if (ext === '.pdf') {
    const { extractLinks, extractText, getDocumentProxy } = await import('unpdf');
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      text = (await extractText(pdf, { mergePages: true })).text;
      // A CV often shows "LinkedIn" or a project name as a link: the URL is only in the link, not in the text.
      const links = [...new Set((await extractLinks(pdf)).links.filter((l) => /^https?:\/\//i.test(l)))];
      if (links.length) text += `\n\nLinks in the PDF:\n${links.join('\n')}`;
    } catch (e) {
      throw new UserError(`Cannot read the PDF ${file}: ${(e as Error).message}`);
    }
  } else if (ext === '.docx') text = docxText(buf);
  else text = buf.toString('utf8');
  text = text.replace(/\r\n?/g, '\n').trim();
  if (text.length < MIN_TEXT)
    throw new UserError(
      `${file} has almost no text (${text.length} characters): a scanned CV is an image. Export it as text or a PDF made from Word.`,
    );
  return text;
}

// Letters and digits only, lower case: "React.js" and "react js" compare alike.
const flat = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}+#]+/gu, '');

/** Whether `text` (already flattened) contains `item`, also without a ".js" / "js" ending ("React.js" for "React"). */
function mentions(flatText: string, item: string): boolean {
  const f = flat(item);
  if (!f) return false;
  return flatText.includes(f) || (/js$/.test(f) && f.length > 4 && flatText.includes(f.slice(0, -2)));
}

export type ImportCheck = { cv: Cv; dropped: string[]; warnings: string[] };

/**
 * Checks the AI's draft against the CV text: a skill the text does not contain is dropped (the master CV is the
 * source of truth for skills, so an invented one would spread to every CV and letter), and an employer, school or
 * name it does not contain is reported for the user to check. Empty skill groups are removed.
 */
export function checkImported(cv: Cv, text: string): ImportCheck {
  const t = flat(text);
  const dropped: string[] = [];
  const skills = cv.skills
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => {
        const ok = mentions(t, i);
        if (!ok) dropped.push(i);
        return ok;
      }),
    }))
    .filter((g) => g.items.length);
  const warnings: string[] = [];
  if (!mentions(t, cv.name)) warnings.push(`The name "${cv.name}" is not in the CV text.`);
  for (const e of cv.experience)
    if (e.company && !mentions(t, e.company)) warnings.push(`The employer "${e.company}" is not in the CV text.`);
  for (const e of cv.education) if (e.school && !mentions(t, e.school)) warnings.push(`The school "${e.school}" is not in the CV text.`);
  return { cv: { ...cv, skills }, dropped, warnings };
}

/** The draft as saved: the CV plus what the check removed and found, for the user to review. */
export type ImportDraft = { source: string; created_at: string; cv: Cv; dropped: string[]; warnings: string[] };
