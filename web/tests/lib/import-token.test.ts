import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { botDataDir } from '@/lib/bot';
import { importToken, isImportToken } from '@/lib/extension';

// The token file goes to a temp data folder (JOB_BOT_DATA_DIR, read on every call), never the real data/.
const dataDir = mkdtempSync(join(tmpdir(), 'talaash-web-token-'));
const saved = process.env.JOB_BOT_DATA_DIR;
process.env.JOB_BOT_DATA_DIR = join(dataDir, 'data');

const file = join(dataDir, 'data', 'import-token');
beforeEach(() => rmSync(join(dataDir, 'data'), { recursive: true, force: true }));
afterAll(() => {
  process.env.JOB_BOT_DATA_DIR = saved;
  rmSync(dataDir, { recursive: true, force: true });
});

it('keeps the token in JOB_BOT_DATA_DIR', () => {
  expect(botDataDir()).toBe(join(dataDir, 'data'));
  importToken();
  expect(existsSync(file)).toBe(true);
});

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
