import { createHash } from 'node:crypto';
import { getJob } from '../db.ts';
import { readJsonInput, row, save, type Flags } from './shared.ts';

/** Add a job found manually or by Claude in the browser (LinkedIn, Bayt, GulfTalent, ...). JSON via --file or stdin. */
export async function add(_args: string[], flags: Flags) {
  const input = readJsonInput(flags.file);
  for (const j of Array.isArray(input) ? input : [input]) {
    const source = j.source ?? 'manual';
    const id = `${source}:${createHash('sha1').update(j.url).digest('hex').slice(0, 12)}`;
    await save({
      id,
      source,
      company: j.company,
      title: j.title,
      location: j.location ?? '',
      url: j.url,
      description: j.description ?? '',
      posted_at: j.posted_at ?? null,
    });
    const saved = (await getJob(id))!;
    console.log(saved.status === 'filtered' ? `filtered: ${saved.filter_reason}\n      id: ${id}` : row(saved));
  }
}
