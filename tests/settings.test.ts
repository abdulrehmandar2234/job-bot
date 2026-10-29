import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvalidSettingsError, loadSettings, path, validateApplicant, validateConfig, validateText } from '../src/settings.ts';

const realConfig = () => JSON.parse(readFileSync(path('config.json'), 'utf8'));
const example = () => JSON.parse(readFileSync(path('cv', 'applicant.example.json'), 'utf8'));
const errorsOf = (r: { ok: boolean; errors?: { path: string; message: string }[] }) => (r.ok ? [] : r.errors!);

describe('config validation', () => {
  it('accepts the real config.json and returns it unchanged, unknown keys included', () => {
    const c = { ...realConfig(), futureOption: 1 };
    const r = validateConfig(c);
    assert.ok(r.ok);
    assert.equal(r.value, c);
  });

  it('names the path of every bad field', () => {
    const c = realConfig();
    c.ai.concurrency = '2';
    c.companies[1].ats = 'workday';
    c.roleExclude = '(unclosed';
    delete c.minScore;
    const errors = errorsOf(validateConfig(c));
    const byPath = Object.fromEntries(errors.map((e) => [e.path, e.message]));
    assert.deepEqual(Object.keys(byPath).sort(), ['ai.concurrency', 'companies[1].ats', 'minScore', 'roleExclude']);
    assert.match(byPath['ai.concurrency'], /expected number, received string/);
    assert.match(byPath['companies[1].ats'], /greenhouse/);
    assert.match(byPath.roleExclude, /not a valid regular expression/);
    assert.match(byPath.minScore, /expected number, received undefined/);
  });

  it('checks country entries and positive numbers', () => {
    const c = realConfig();
    c.countries.NL.visa = 'none';
    c.ai.concurrency = 0;
    assert.deepEqual(errorsOf(validateConfig(c)).map((e) => e.path).sort(), ['ai.concurrency', 'countries.NL.visa']);
  });

  it('rejects something that is not an object', () => {
    assert.deepEqual(errorsOf(validateConfig([])).map((e) => e.path), ['(root)']);
  });
});

describe('applicant validation', () => {
  it('accepts the example file and an empty object (everything unknown)', () => {
    assert.ok(validateApplicant(example()).ok);
    assert.ok(validateApplicant({}).ok);
    assert.ok(validateApplicant({ noticePeriod: '1 month', expectedSalary: { AE: 25000, remote: null }, petName: 'x' }).ok);
  });

  it('names the path of bad facts', () => {
    const a = example();
    a.expectedSalary.AE = { min: 1 };
    a.noticePeriod = ['1 month'];
    const errors = errorsOf(validateApplicant(a));
    assert.deepEqual(errors.map((e) => e.path).sort(), ['expectedSalary.AE', 'noticePeriod']);
  });
});

describe('settings files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jobbot-settings-'));

  it('reports invalid JSON as an error, not an exception', () => {
    const r = validateText('config', '{ "minScore": ');
    assert.equal(r.ok, false);
    assert.match(errorsOf(r)[0].message, /^invalid JSON: /);
  });

  it('loadSettings throws a message with the file and each field', () => {
    const f = join(dir, 'config.json');
    writeFileSync(f, JSON.stringify({ ...realConfig(), maxAgeDays: -1 }));
    assert.throws(() => loadSettings('config', f), (e: unknown) => {
      assert.ok(e instanceof InvalidSettingsError);
      assert.match(e.message, new RegExp(`Invalid settings file ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\n  - maxAgeDays: `));
      return true;
    });
    assert.throws(() => loadSettings('applicant', join(dir, 'missing.json')), /missing\.json:\n  - \(root\): file not found/);
  });
});
