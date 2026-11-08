import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
  it('lists every design with a name and description, classic first and the default', () => {
    expect(lib.TEMPLATES.map((t) => t.id)).toEqual(['classic', 'modern', 'compact']);
    for (const t of lib.TEMPLATES) expect(t.name && t.description).toBeTruthy();
    expect(lib.DEFAULT_TEMPLATE).toBe('classic');
  });

  it('isTemplate accepts only listed names', () => {
    expect(lib.isTemplate('compact')).toBe(true);
    for (const v of ['Compact', '', 'x', null, undefined, 1, '../classic']) expect(lib.isTemplate(v)).toBe(false);
    expect(lib.templateName('modern')).toBe('Modern');
  });
});

describe('CV_VERSION', () => {
  it('is the one rule for a version name', () => {
    for (const v of ['default', 'laravel-v1', 'a', 'custom-acme-v2']) expect(lib.CV_VERSION.test(v)).toBe(true);
    for (const v of ['-v1', '-', 'Laravel', 'a b', '../etc', 'x/y', '']) expect(lib.CV_VERSION.test(v)).toBe(false);
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

  it('cvFileName and cvPath read cvFileName from the config file JOB_BOT_CONFIG names', () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ cvFileName: 'Root_CV.pdf' }));
    expect(lib.cvFileName()).toBe('Root_CV.pdf'); // no override: config.json in BOT_ROOT
    expect(lib.cvPath('default')).toBe(join(root, 'cv', 'default', 'Root_CV.pdf'));
    const other = join(root, 'other-config.json');
    writeFileSync(other, JSON.stringify({ cvFileName: 'Jane_Doe_CV.pdf' }));
    process.env.JOB_BOT_CONFIG = other;
    expect(lib.cvFileName()).toBe('Jane_Doe_CV.pdf');
    expect(lib.cvPath('laravel-v1')).toBe(join(root, 'cv', 'versions', 'laravel-v1', 'Jane_Doe_CV.pdf'));
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
    for (const v of ['laravel-v1', 'broken-v1', 'missing-v1', 'default', '../etc', '-v1'])
      expect(lib.versionInfo(v)).toEqual({ template: 'classic', feedbackNote: [] });
  });
});
