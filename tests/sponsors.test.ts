import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch } from './helpers.ts'; // first: it points the bot at a temp config before src/ loads one
import { indRegisterStale, indUpdatedAt, isIndSponsor, updateIndRegister } from '../src/sponsors.ts';
import { timing } from '../src/sources/http.ts';

// The Dutch IND sponsor register in a temp file (JOB_BOT_IND_FILE), never data/ind-sponsors.json; the download is a
// mocked fetch.
const dir = mkdtempSync(join(tmpdir(), 'job-bot-ind-'));
const file = join(dir, 'ind-sponsors.json');
const was = process.env.JOB_BOT_IND_FILE;
process.env.JOB_BOT_IND_FILE = file;
after(() => {
  if (was === undefined) delete process.env.JOB_BOT_IND_FILE;
  else process.env.JOB_BOT_IND_FILE = was;
  rmSync(dir, { recursive: true, force: true });
});

const now = new Date('2026-11-10T09:00:00Z');
const daysBefore = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
const page = (names: string[]) => `<table>${names.map((n) => `<tr><th scope="row">${n}</th><td>x</td></tr>`).join('')}</table>`;

describe('indRegisterStale', () => {
  it('is stale when missing, unreadable, without a date or older than 7 days; fresh otherwise', () => {
    const f = join(dir, 'stale.json');
    assert.equal(indRegisterStale(now, f), true); // missing
    writeFileSync(f, 'not json');
    assert.equal(indRegisterStale(now, f), true);
    writeFileSync(f, JSON.stringify({ names: [] }));
    assert.equal(indRegisterStale(now, f), true);
    writeFileSync(f, JSON.stringify({ updated: daysBefore(8), names: [] }));
    assert.equal(indRegisterStale(now, f), true);
    writeFileSync(f, JSON.stringify({ updated: daysBefore(2), names: [] }));
    assert.equal(indRegisterStale(now, f), false);
    assert.equal(indUpdatedAt(f)?.toISOString(), daysBefore(2));
  });
});

describe('updateIndRegister', () => {
  it('downloads the register into JOB_BOT_IND_FILE, which isIndSponsor then reads', async () => {
    const names = ['Adyen N.V.', ...Array.from({ length: 1000 }, (_, i) => `Company ${i} B.V.`)];
    const net = mockFetch({ 'ind.nl/en/public-register-recognised-sponsors': page(names) });
    try {
      assert.equal(await updateIndRegister(), names.length);
    } finally {
      net.restore();
    }
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).names.length, names.length);
    assert.equal(indRegisterStale(new Date(), file), false);
    assert.equal(isIndSponsor('Adyen', []), true);
    assert.equal(isIndSponsor('Unknown Startup', []), false);
  });

  it('refuses a page that does not look like the register, keeping the saved file', async () => {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
    const scale = timing.scale;
    timing.scale = 0;
    const net = mockFetch({ 'ind.nl/': page(['Only One B.V.']) });
    try {
      await assert.rejects(updateIndRegister(), /IND register looks wrong: only 1 rows parsed/);
    } finally {
      net.restore();
      timing.scale = scale;
    }
    assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, before);
  });
});
