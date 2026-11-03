import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOT_ROOT } from '@/lib/bot';
import { importToken, isImportToken } from '@/lib/extension';

// The token file goes to a temp "bot root", never the real data/.
vi.mock('@/lib/bot', async (importOriginal) => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return { ...(await importOriginal<typeof import('@/lib/bot')>()), BOT_ROOT: mkdtempSync(j(tmpdir(), 'job-bot-web-token-')) };
});

const file = join(BOT_ROOT, 'data', 'import-token');
beforeEach(() => rmSync(join(BOT_ROOT, 'data'), { recursive: true, force: true }));
afterAll(() => rmSync(BOT_ROOT, { recursive: true, force: true }));

describe('importToken', () => {
  it('creates a random 64-hex token in data/import-token on first use and then keeps it', () => {
    expect(existsSync(file)).toBe(false);
    const token = importToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
    expect(importToken()).toBe(token); // stable across calls
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600); // owner-only
  });

  it('replaces a file whose content is not a token', () => {
    const first = importToken();
    writeFileSync(file, 'not a token\n');
    const token = importToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(token).not.toBe(first);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
  });

  it('generates a different token per installation', () => {
    const first = importToken();
    rmSync(file);
    expect(importToken()).not.toBe(first);
  });
});

describe('isImportToken', () => {
  it('accepts exactly the stored token', () => {
    const token = importToken();
    expect(isImportToken(token)).toBe(true);
  });

  it.each([
    ['null (header missing)', null],
    ['the empty string', ''],
    ['a wrong token of the right length', 'f'.repeat(64)],
    ['a prefix', 'too short'],
  ])('rejects %s', (_, value) => {
    importToken();
    expect(isImportToken(value === 'too short' ? importToken().slice(0, 32) : value)).toBe(false);
  });
});
