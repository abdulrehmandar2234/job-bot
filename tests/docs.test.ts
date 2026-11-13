import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

// The docs site (docs/.vitepress/config.mts) shows only the pages in its sidebar; its build (CI, docs.yml) catches dead
// links inside docs/, and these catch a page left out of the sidebar and README links to files that do not exist.
const ROOT = join(import.meta.dirname, '..');
const DOCS = join(ROOT, 'docs');
const docPages = (dir = DOCS): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return [];
    const path = join(dir, e.name);
    return e.isDirectory() ? docPages(path) : e.name.endsWith('.md') ? [relative(DOCS, path)] : [];
  });

describe('the docs site', () => {
  const site = readFileSync(join(DOCS, '.vitepress', 'config.mts'), 'utf8');
  const sidebar = new Set([...site.matchAll(/link: '(\/[^']*)'/g)].map((m) => m[1]));
  const route = (page: string) => (page === 'README.md' ? '/' : `/${page.replace(/\.md$/, '').split(sep).join('/')}`);

  it('has every page of docs/ in its sidebar, and no sidebar entry without a page', () => {
    const pages = docPages();
    for (const page of ['README.md', 'quickstart.md', 'features.md', 'cli.md', 'how-it-works.md', join('install', 'macos.md')])
      assert.ok(pages.includes(page), page);
    const missing = pages.filter((p) => !sidebar.has(route(p)));
    assert.deepEqual(missing, [], `docs pages missing from the sidebar in docs/.vitepress/config.mts: ${missing.join(', ')}`);
    const routes = new Set(pages.map(route));
    const dangling = [...sidebar].filter((r) => !routes.has(r));
    assert.deepEqual(dangling, [], `sidebar entries without a page: ${dangling.join(', ')}`);
  });

  it('README.md links only to files that exist', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const local = [...readme.matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
    assert.ok(local.includes('docs/quickstart.md'));
    // Images in HTML tags too: <img src>, <source srcset>.
    const images = [...readme.matchAll(/\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1]).filter((l) => !/^https?:/.test(l));
    assert.ok(images.includes('docs/images/hero.svg'));
    const broken = [...local, ...images].filter((l) => !existsSync(join(ROOT, l)));
    assert.deepEqual(broken, [], `README.md links to missing files: ${broken.join(', ')}`);
  });
});

describe('release files', () => {
  const ROOT = join(import.meta.dirname, '..');
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

  it('CHANGELOG.md has a dated section and a link for the version in package.json, and an Unreleased section', () => {
    const { version } = JSON.parse(read('package.json')) as { version: string };
    const changelog = read('CHANGELOG.md');
    assert.match(changelog, /^## \[Unreleased\]$/m);
    assert.match(changelog, new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    assert.match(
      changelog,
      new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: https://github\\.com/.+/releases/tag/v${version.replace(/\./g, '\\.')}$`, 'm'),
    );
    assert.equal(JSON.parse(read('web', 'package.json')).version, version, 'the dashboard has the same version');
  });

  it('has SECURITY.md and issue templates that ask for no personal data', () => {
    assert.match(read('SECURITY.md'), /Report a vulnerability/);
    const dir = join(ROOT, '.github', 'ISSUE_TEMPLATE');
    assert.deepEqual(readdirSync(dir).sort(), ['bug_report.yml', 'config.yml', 'feature_request.yml']);
    assert.match(read('.github', 'ISSUE_TEMPLATE', 'bug_report.yml'), /leave out anything personal/);
    assert.match(read('.github', 'ISSUE_TEMPLATE', 'feature_request.yml'), /never applies on your behalf/);
  });
});
