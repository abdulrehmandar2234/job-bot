import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as bot from '../../../src/cv/templates/index';

// lib/bot.ts resolves BOT_ROOT from the working directory (web/..) at import time: point it at a temp folder.
const root = mkdtempSync(join(tmpdir(), 'job-bot-web-tpl-'));
let lib: typeof import('@/lib/cv-templates');

beforeAll(async () => {
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(root, 'web'));
  try {
    lib = await import('@/lib/cv-templates');
  } finally {
    cwd.mockRestore();
  }
});
afterEach(() => {
  delete process.env.JOB_BOT_CONFIG;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the template list', () => {
  it('matches the bot (src/cv/templates/index.ts): ids, names and descriptions, classic first and the default', () => {
    expect(lib.TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description }))).toEqual(
      bot.TEMPLATE_IDS.map((id) => ({ id, name: bot.TEMPLATES[id].name, description: bot.TEMPLATES[id].description })),
    );
    expect(lib.DEFAULT_TEMPLATE).toBe(bot.DEFAULT_TEMPLATE);
  });

  it('isTemplate accepts only listed names', () => {
    expect(lib.isTemplate('compact')).toBe(true);
    for (const v of ['Compact', '', 'x', null, undefined, 1, '../classic']) expect(lib.isTemplate(v)).toBe(false);
    expect(lib.templateName('modern')).toBe('Modern');
  });
});

describe('server helpers', () => {
  it('defaultTemplate reads config.json cvTemplate, else classic', () => {
    const config = join(root, 'config.json');
    process.env.JOB_BOT_CONFIG = config;
    writeFileSync(config, JSON.stringify({ cvTemplate: 'modern' }));
    expect(lib.defaultTemplate()).toBe('modern');
    writeFileSync(config, JSON.stringify({ cvTemplate: 'fancy' }));
    expect(lib.defaultTemplate()).toBe('classic');
    writeFileSync(config, '{}');
    expect(lib.defaultTemplate()).toBe('classic');
  });

  it("versionInfo reads a version's template and feedback note; default, old versions and bad ids are classic", () => {
    const dir = (id: string, meta: object | string) => {
      mkdirSync(join(root, 'cv', 'versions', id), { recursive: true });
      writeFileSync(join(root, 'cv', 'versions', id, 'meta.json'), typeof meta === 'string' ? meta : JSON.stringify(meta));
    };
    dir('laravel-compact-v1', { id: 'laravel-compact-v1', template: 'compact' });
    dir('custom-acme-v2', { id: 'custom-acme-v2', template: 'modern', feedbackNote: ['Skill "Go" (not on your master CV)', 3] });
    dir('laravel-v1', { id: 'laravel-v1' });
    dir('broken-v1', '{');
    expect(lib.versionInfo('laravel-compact-v1')).toEqual({ template: 'compact', feedbackNote: [] });
    expect(lib.versionInfo('custom-acme-v2')).toEqual({ template: 'modern', feedbackNote: ['Skill "Go" (not on your master CV)'] });
    for (const v of ['laravel-v1', 'broken-v1', 'missing-v1', 'default', '../etc'])
      expect(lib.versionInfo(v)).toEqual({ template: 'classic', feedbackNote: [] });
  });
});
