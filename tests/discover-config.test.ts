import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { TEST_DB } from './helpers.ts';
import { path } from '../src/config.ts';
import { addToConfig } from '../src/discover.ts';
import { InvalidSettingsError } from '../src/settings.ts';

// `discover --add` writes the boards it found to the config file the bot uses (JOB_BOT_CONFIG when set), only when
// the result is valid, and atomically. The real config.json is never touched.
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-discover-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
const REAL = readFileSync(path('config.default.json'), 'utf8');

/** A temp copy of config.json with two companies. */
function configCopy(edit: (c: Record<string, any>) => void = () => {}) {
  const c = JSON.parse(REAL);
  c.companies = [
    { name: 'Acme', ats: 'greenhouse', token: 'acme' },
    { name: 'Beta', ats: 'lever', token: 'beta' },
  ];
  edit(c);
  const dir = mkdtempSync(join(tmp, 'cfg-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(c, null, 2) + '\n');
  return file;
}
const companies = (file: string) => JSON.parse(readFileSync(file, 'utf8')).companies;

describe('addToConfig', () => {
  it('appends new boards with target-country jobs, skipping known ones and boards without target jobs', () => {
    const file = configCopy();
    const added = addToConfig(
      [
        { slug: 'new-co', ats: 'ashby', jobs: 3, target: 2 },
        { slug: 'acme', ats: 'greenhouse', jobs: 5, target: 5 },
        { slug: 'faraway', ats: 'lever', jobs: 4, target: 0 },
      ],
      file,
    );
    assert.deepEqual(added, [{ name: 'New Co', ats: 'ashby', token: 'new-co' }]);
    assert.deepEqual(companies(file).at(-1), { name: 'New Co', ats: 'ashby', token: 'new-co' });
    assert.equal(companies(file).length, 3);
    assert.match(readFileSync(file, 'utf8'), /\n}\n$/);
    assert.deepEqual(readdirSync(join(file, '..')), ['config.json'], 'no temp file left behind');
  });

  it('leaves the file alone when nothing is new', () => {
    const file = configCopy();
    const before = readFileSync(file, 'utf8');
    assert.deepEqual(addToConfig([{ slug: 'acme', ats: 'greenhouse', jobs: 1, target: 1 }], file), []);
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('refuses to write an invalid config and leaves the file as it was', () => {
    const file = configCopy((c) => {
      c.countries.AE.visa = 'maybe';
    });
    const before = readFileSync(file, 'utf8');
    assert.throws(
      () => addToConfig([{ slug: 'new-co', ats: 'ashby', jobs: 3, target: 2 }], file),
      (e) => e instanceof InvalidSettingsError && e.file === file && /countries\.AE\.visa/.test(e.message),
    );
    assert.equal(readFileSync(file, 'utf8'), before);
  });
});

describe('discover --add (CLI)', () => {
  it('writes to the file JOB_BOT_CONFIG names, never the real config.json', async () => {
    const file = configCopy();
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', 'discover', 'gamma', '--add'],
      {
        cwd: path(),
        env: {
          ...process.env,
          DATABASE_URL: TEST_DB,
          JOB_BOT_CONFIG: file,
          NODE_OPTIONS: `--import=${pathToFileURL(join(import.meta.dirname, 'fixtures', 'fake-fetch.mjs')).href}`,
          FAKE_FETCH: JSON.stringify({
            'boards-api.greenhouse.io/v1/boards/gamma/': { body: JSON.stringify({ jobs: [{ location: { name: 'Dubai' } }] }) },
          }),
        },
        timeout: 60_000,
      },
    );
    assert.match(stdout, /added to config\.json: Gamma \(greenhouse:gamma\)/);
    assert.deepEqual(companies(file).at(-1), { name: 'Gamma', ats: 'greenhouse', token: 'gamma' });
    assert.equal(readFileSync(path('config.default.json'), 'utf8'), REAL);
  });
});
