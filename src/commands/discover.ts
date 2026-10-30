import { basename } from 'node:path';
import { addToConfig, discover as findBoards } from '../discover.ts';
import { configFile } from '../settings.ts';
import type { Flags } from './shared.ts';

/** Find which job board companies use: discover careem salla foodics [--add] */
export async function discover(args: string[], flags: Flags) {
  const hits = await findBoards(args);
  for (const h of hits)
    console.log(`${h.target ? '★' : ' '} ${h.ats.padEnd(15)} ${h.slug.padEnd(22)} jobs=${h.jobs} in target countries=${h.target}`);
  if (!hits.length) console.log('No public job board found for these names (try other spellings, e.g. "acme", "acmeinc", "acme-tech").');
  if (flags.add) for (const c of addToConfig(hits)) console.log(`added to ${basename(configFile())}: ${c.name} (${c.ats}:${c.token})`);
}
