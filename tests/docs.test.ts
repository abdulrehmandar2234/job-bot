import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { z } from 'zod';
import { configSchema } from '../src/settings.ts';

// docs/configuration.md documents every config.json key (CLAUDE.md: a new setting needs a row there). This walks the
// zod schema the bot validates config.json with, so a key added to src/settings.ts without a docs row fails here.
const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'configuration.md'), 'utf8');

// Sections documented as one row for the whole object rather than a row per field. Keep this short: a new section
// normally gets a row per field.
const DOCUMENTED_AS_A_WHOLE = new Set([
  'ai.openai', // older provider sections, one row "`ai.openai`, `ai.deepseek`": their fields match ai.api's
  'ai.deepseek',
]);

/**
 * The dotted keys of a schema's leaves, in the docs' own notation: `ai.api.preset`, `countries.<code>.name` for a
 * record's values, `companies[].token` for an array of objects. Containers (objects, records, arrays of objects) are
 * listed too, since the docs give them a row of their own when they are optional sections or keyed maps.
 */
function configKeys(schema: z.ZodType, prefix = ''): { key: string; container: boolean }[] {
  const def = (schema as unknown as { def: Record<string, any> }).def;
  switch (def.type) {
    case 'optional':
    case 'nullable':
    case 'default':
      return configKeys(def.innerType, prefix);
    case 'object': {
      const out = prefix ? [{ key: prefix, container: true }] : [];
      if (DOCUMENTED_AS_A_WHOLE.has(prefix)) return [{ key: prefix, container: false }];
      for (const [name, field] of Object.entries(def.shape as Record<string, z.ZodType>))
        out.push(...configKeys(field, prefix ? `${prefix}.${name}` : name));
      return out;
    }
    case 'record':
      return [
        { key: prefix, container: true },
        ...configKeys(def.valueType, `${prefix}.<code>`).filter((k) => k.key !== `${prefix}.<code>`),
      ];
    case 'array': {
      const element = configKeys(def.element, `${prefix}[]`).filter((k) => k.key !== `${prefix}[]`);
      return element.length ? [{ key: prefix, container: true }, ...element] : [{ key: prefix, container: false }];
    }
    default:
      return [{ key: prefix, container: false }];
  }
}

const keys = configKeys(configSchema);
const documented = (key: string) => doc.includes(`\`${key}\``);

describe('docs/configuration.md', () => {
  it('walks the schema into nested sections, keyed maps and arrays of objects', () => {
    const all = keys.map((k) => k.key);
    for (const key of ['cvFileName', 'remote.boards', 'ai.api.preset', 'countries.<code>.visa', 'companies[].token', 'ai.openai'])
      assert.ok(all.includes(key), key);
    assert.ok(!all.includes('ai.openai.scoreModel'), 'a section documented as a whole is not walked into');
  });

  it('has a row for every config.json setting', () => {
    const missing = keys.filter((k) => !k.container && !documented(k.key)).map((k) => k.key);
    assert.deepEqual(missing, [], `config keys without a row in docs/configuration.md: ${missing.join(', ')}`);
  });

  it('documents no config.json key that the schema does not have', () => {
    const known = new Set(keys.map((k) => k.key));
    // First-column keys of the tables that look like config paths (env vars are UPPER_CASE).
    const rows = [...doc.matchAll(/^\| `([a-z][\w.<>[\]]*)`/gm)].map((m) => m[1]);
    const unknown = rows.filter((k) => !known.has(k));
    assert.deepEqual(unknown, [], `rows in docs/configuration.md for keys config.json does not have: ${unknown.join(', ')}`);
  });
});
