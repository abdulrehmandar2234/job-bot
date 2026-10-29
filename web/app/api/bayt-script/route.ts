import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOT_ROOT } from '@/lib/bot';

/** The Bayt collector, loaded into a bayt.com tab by the dashboard's bookmarklet. */
export async function GET() {
  const js = await readFile(join(BOT_ROOT, 'scripts', 'bayt-collect.js'), 'utf8');
  return new Response(js, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}
