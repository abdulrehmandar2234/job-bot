import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { path } from './settings.ts';

// Ready-made starting points for config.json, in presets/: markets (where to look: countries, LinkedIn locations,
// company boards) and stacks (what to look for: keywords and title filters). `npm run bot -- setup` offers them;
// applying them replaces only the fields they cover, so the rest of config.json stays as it is.
// config.default.json is the gulf + netherlands + pakistan markets with the php-laravel + javascript stacks.

export const PRESETS_DIR = path('presets');

/** Title words every software role matches, whatever the stack. */
export const BASE_ROLE_INCLUDE = 'engineer|developer|full.?stack|back.?end|front.?end|software|web';

const text = z.string().min(1);

const marketSchema = z.object({
  name: text,
  description: text,
  countries: z.record(z.string().regex(/^[A-Z]{2}$/), z.record(z.string(), z.unknown())),
  linkedinLocations: z.array(text),
  adzunaCountries: z.array(z.string().regex(/^[a-z]{2}$/)),
  companies: z.array(z.object({ name: text, ats: text, token: text }).loose()),
});

const stackSchema = z.object({
  name: text,
  description: text,
  linkedinKeywords: z.array(text),
  remoteQueries: z.array(text),
  roleInclude: text, // title words, "|"-separated, added to BASE_ROLE_INCLUDE
  allowInTitles: z.array(text), // roleExclude parts this stack must not filter out (e.g. "python")
});

export type Market = z.infer<typeof marketSchema> & { id: string };
export type Stack = z.infer<typeof stackSchema> & { id: string };
export type PresetKind = 'markets' | 'stacks';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const union = <T>(lists: T[][]) => [...new Set(lists.flat())];

function load<S extends z.ZodType>(kind: PresetKind, schema: S, dir: string): (z.infer<S> & { id: string })[] {
  const folder = join(dir, kind);
  if (!existsSync(folder)) return [];
  return readdirSync(folder)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const id = f.slice(0, -'.json'.length);
      const res = schema.safeParse(JSON.parse(readFileSync(join(folder, f), 'utf8')));
      if (!res.success)
        throw new Error(`presets/${kind}/${f}: ${res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
      return { ...(res.data as object), id } as z.infer<S> & { id: string };
    });
}

export const loadMarkets = (dir = PRESETS_DIR): Market[] => load('markets', marketSchema, dir);
export const loadStacks = (dir = PRESETS_DIR): Stack[] => load('stacks', stackSchema, dir);

/** The presets with these ids, in the order given; throws on an unknown id and lists the known ones. */
export function pick<T extends { id: string }>(all: T[], ids: string[], kind: PresetKind): T[] {
  return ids.map((id) => {
    const found = all.find((p) => p.id === id.trim().toLowerCase());
    if (!found) throw new Error(`unknown ${kind.slice(0, -1)} preset "${id}" (known: ${all.map((p) => p.id).join(', ')})`);
    return found;
  });
}

/** Splits a regex on its top-level "|" (not inside groups or classes), so "a|(b|c)|d" gives a, (b|c), d. */
export function alternatives(re: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cls = false;
  let cur = '';
  for (let i = 0; i < re.length; i++) {
    const ch = re[i];
    if (ch === '\\') {
      cur += ch + (re[++i] ?? '');
      continue;
    }
    if (cls) cls = ch !== ']';
    else if (ch === '[') cls = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === '|' && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.filter(Boolean);
}

/**
 * config.json with these markets: countries, LinkedIn locations, Adzuna countries and company boards come from them
 * (companies deduplicated by board). Everything else is kept. Returns a new object.
 */
export function applyMarkets(cfg: Json, markets: Market[]): Json {
  if (!markets.length) return cfg;
  const linkedin = isObj(cfg.linkedin) ? cfg.linkedin : {};
  const adzuna = isObj(cfg.adzuna) ? cfg.adzuna : {};
  const seen = new Set<string>();
  const companies = markets
    .flatMap((m) => m.companies)
    .filter((c) => {
      const key = `${c.ats}:${c.token}`.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return {
    ...cfg,
    countries: Object.assign({}, ...markets.map((m) => m.countries)),
    linkedin: { ...linkedin, locations: union(markets.map((m) => m.linkedinLocations)) },
    adzuna: { ...adzuna, countries: union(markets.map((m) => m.adzunaCountries)) },
    companies,
  };
}

/**
 * config.json with these stacks: LinkedIn keywords, remote board queries and roleInclude come from them, and
 * roleExclude loses the parts a stack needs (Python roles are excluded by default). Everything else is kept.
 */
export function applyStacks(cfg: Json, stacks: Stack[]): Json {
  if (!stacks.length) return cfg;
  const linkedin = isObj(cfg.linkedin) ? cfg.linkedin : {};
  const remote = isObj(cfg.remote) ? cfg.remote : {};
  const allowed = new Set(stacks.flatMap((s) => s.allowInTitles.map((a) => a.toLowerCase())));
  const exclude = alternatives(String(cfg.roleExclude ?? ''));
  return {
    ...cfg,
    linkedin: { ...linkedin, keywords: union(stacks.map((s) => s.linkedinKeywords)) },
    remote: { ...remote, himalayasQueries: union(stacks.map((s) => s.remoteQueries)) },
    roleInclude: union([alternatives(BASE_ROLE_INCLUDE), ...stacks.map((s) => alternatives(s.roleInclude))]).join('|'),
    roleExclude: exclude.filter((p) => !allowed.has(p.replace(/\\b/g, '').toLowerCase())).join('|'),
  };
}
