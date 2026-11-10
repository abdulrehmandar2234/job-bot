import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './errors.ts';
import { path, type SettingsError } from './settings.ts';

// Ready-made starting points for config.json, in presets/: markets (where to look: countries, LinkedIn locations,
// company boards) and stacks (what to look for: keywords and title filters). `npm run bot -- setup` offers them;
// applying them replaces only the fields they cover, so the rest of config.json stays as it is.
// config.default.json is the gulf + netherlands + pakistan markets with the php-laravel + javascript stacks.

export const PRESETS_DIR = path('presets');

/** Title words every software role matches, whatever the stack. */
export const BASE_ROLE_INCLUDE = 'engineer|developer|full.?stack|back.?end|front.?end|software|web|\\bsde\\b';

const text = z.string().min(1);
const regex = text.refine((s) => {
  try {
    new RegExp(s, 'i');
    return true;
  } catch {
    return false;
  }
}, 'not a valid regular expression');

const marketSchema = z.object({
  name: text,
  description: text,
  countries: z.record(z.string().regex(/^[A-Z]{2}$/), z.record(z.string(), z.unknown())),
  linkedinLocations: z.array(text),
  adzunaCountries: z.array(z.string().regex(/^[a-z]{2}$/)),
  companies: z.array(z.object({ name: text, ats: text, token: text }).loose()),
});

// A skill the keyword score looks for in postings (src/match.ts). `cv` = other CV wording that also proves it
// (MySQL proves SQL). A stack skill with the same name as a cross-stack one (src/match.ts BASE_SKILLS) replaces it.
const skillSchema = z.object({
  name: text,
  pattern: regex, // matched against the job title + description, and against the master CV for `have`
  weight: z.number().int().positive().optional(), // missing = 1
  cv: regex.optional(),
});

// Which CV version (cluster) fits a posting: every `all` pattern must match and no `none` pattern may. The most
// specific cluster wins (highest `priority` first, then the most `all` patterns); 'default' = the untouched CV.
const clusterSchema = z.object({
  id: text,
  all: z.array(regex).min(1),
  none: z.array(regex).optional(),
  priority: z.number().int().optional(), // missing = 0; higher beats specificity
});

const stackSchema = z.object({
  name: text,
  description: text,
  linkedinKeywords: z.array(text),
  remoteQueries: z.array(text),
  roleInclude: text, // title words, "|"-separated, added to BASE_ROLE_INCLUDE
  allowInTitles: z.array(text), // roleExclude parts this stack must not filter out (e.g. "python")
  skills: z.array(skillSchema).default([]), // what the keyword score looks for when this stack is active
  clusters: z.array(clusterSchema).default([]), // which CV framing fits a posting (src/cv/profiles.ts ids)
});

/** The stacks scoring falls back to when config.json has no `stacks` key: what config.default.json is built from. */
export const DEFAULT_STACKS = ['php-laravel', 'javascript'];

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

const findPreset = <T extends { id: string }>(all: T[], id: string) => all.find((p) => p.id === id.trim().toLowerCase());

/** The presets with these ids, in the order given; throws a ConfigError on an unknown id and lists the known ones. */
export function pick<T extends { id: string }>(all: T[], ids: string[], kind: PresetKind): T[] {
  return ids.map((id) => {
    const found = findPreset(all, id);
    if (!found) throw new ConfigError(`unknown ${kind.slice(0, -1)} preset "${id}" (known: ${all.map((p) => p.id).join(', ')})`);
    return found;
  });
}

/**
 * config.json `stacks` checked against the stack preset files: one error per unknown id, in the settings error shape
 * (`stacks[1]`). Missing, empty or not a list of strings gives none (the schema reports a wrong type). It reads
 * presets/, so it runs where settings are loaded or saved (src/config.ts, settings:check / settings:save), never in
 * the zod schema the dashboard imports.
 */
export function stackErrors(stacks: unknown, dir = PRESETS_DIR): SettingsError[] {
  if (!Array.isArray(stacks) || !stacks.length) return [];
  const all = loadStacks(dir);
  const known = all.map((s) => s.id).join(', ');
  return stacks.flatMap((id, i) =>
    typeof id !== 'string' || !id || findPreset(all, id)
      ? []
      : [{ path: `stacks[${i}]`, message: `unknown stack "${id}" (known: ${known}; one per file in presets/stacks/)` }],
  );
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
 * roleExclude loses the parts a stack needs (Python roles are excluded by default). The chosen ids go into `stacks`,
 * so scoring (src/match.ts) uses these stacks' skills and CV clusters too. Everything else is kept.
 */
export function applyStacks(cfg: Json, stacks: Stack[]): Json {
  if (!stacks.length) return cfg;
  const linkedin = isObj(cfg.linkedin) ? cfg.linkedin : {};
  const remote = isObj(cfg.remote) ? cfg.remote : {};
  const allowed = new Set(stacks.flatMap((s) => s.allowInTitles.map((a) => a.toLowerCase())));
  const exclude = alternatives(String(cfg.roleExclude ?? ''));
  return {
    ...cfg,
    stacks: stacks.map((s) => s.id),
    linkedin: { ...linkedin, keywords: union(stacks.map((s) => s.linkedinKeywords)) },
    remote: { ...remote, himalayasQueries: union(stacks.map((s) => s.remoteQueries)) },
    roleInclude: union([alternatives(BASE_ROLE_INCLUDE), ...stacks.map((s) => alternatives(s.roleInclude))]).join('|'),
    roleExclude: exclude.filter((p) => !allowed.has(p.replace(/\\b/g, '').toLowerCase())).join('|'),
  };
}
