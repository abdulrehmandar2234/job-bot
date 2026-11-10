import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { baytCountries } from '@/lib/bayt';
import { BOT_ROOT } from '@/lib/bot';
import { importToken } from '@/lib/extension';
import { readConfig } from '@/lib/settings';

// The Bayt collector, loaded into a bayt.com tab by the dashboard's bookmarklet. The script in the repo holds no
// personal values and no credentials: this route injects the user's search settings from config.json, the
// dashboard's own origin (whatever port it runs on) and the import token that POST /api/import requires.

/** A Bayt search slug: "full stack developer" and "node.js" become "full-stack-developer" and "node-js". */
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/**
 * The collector's settings from config.json (linkedin.keywords doubles as the Bayt search list, countries picks
 * the Bayt boards, maxAgeDays the cutoff). A missing or broken config.json injects none, and the collector then
 * falls back to its own defaults, which mirror config.default.json.
 */
function settings(dashboard: string) {
  const config = readConfig().data ?? {};
  const linkedin = config.linkedin;
  const keywords = strings(linkedin && typeof linkedin === 'object' ? (linkedin as Record<string, unknown>).keywords : null);
  const countries = config.countries && typeof config.countries === 'object' ? Object.keys(config.countries) : [];
  return {
    dashboard,
    token: importToken(),
    keywords: [...new Set(keywords.map(slug).filter(Boolean))],
    countries: baytCountries(countries),
    maxAgeDays: typeof config.maxAgeDays === 'number' && config.maxAgeDays > 0 ? config.maxAgeDays : 0,
  };
}

export async function GET(req: NextRequest) {
  const js = await readFile(join(BOT_ROOT, 'scripts', 'bayt-collect.js'), 'utf8');
  const body = js.replace('/*__BAYT_SETTINGS__*/ null', JSON.stringify(settings(new URL(req.url).origin)));
  return new Response(body, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });
}
