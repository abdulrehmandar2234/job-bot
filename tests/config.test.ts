import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import './helpers.ts';
import { config, loadConfig } from '../src/config.ts';
import { path } from '../src/settings.ts';

// src/config.ts reads config.json on first use, so bot modules can be imported (by the dashboard, by `settings:check`)
// without the file being read, and a broken file fails where a setting is actually needed.

/** Imports src/config.ts in a fresh Node with JOB_BOT_CONFIG = `file`, then reads `config.minScore`. */
function importThenRead(file: string) {
  const url = pathToFileURL(path('src', 'config.ts')).href;
  const script = `const { config } = await import(${JSON.stringify(url)});
console.log('imported');
try { console.log('minScore', config.minScore); } catch (e) { console.log('error', e.message); }`;
  return spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, JOB_BOT_CONFIG: file },
    encoding: 'utf8',
    windowsHide: true,
  }).stdout;
}

describe('config.ts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-bot-config-lazy-'));

  it('importing it does not read config.json; the first setting read does, and reports a broken file then', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"minScore": "high"}');
    const out = importThenRead(bad);
    assert.match(out, /^imported\n/);
    assert.match(out, /^error .*bad\.json[\s\S]*minScore/m);
    assert.match(importThenRead(join(dir, 'missing.json')), /^imported\nerror /);
  });

  it('reads a valid file once', () => {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ ...JSON.parse(JSON.stringify(loadConfig())), minScore: 33 }));
    assert.match(importThenRead(good), /^imported\nminScore 33\n$/);
  });

  it('`config` behaves like the loaded object: reads, writes, keys and spreads', () => {
    assert.equal(config.minScore, loadConfig().minScore);
    assert.deepEqual({ ...config }, loadConfig());
    assert.deepEqual(Object.keys(config), Object.keys(loadConfig()));
    assert.ok('countries' in config);
    const was = config.minScore;
    config.minScore = was + 1; // tests change settings in place
    assert.equal(loadConfig().minScore, was + 1);
    config.minScore = was;
  });
});
