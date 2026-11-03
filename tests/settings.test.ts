import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applicantFile,
  configFile,
  InvalidSettingsError,
  loadSettings,
  masterFile,
  path,
  validateApplicant,
  validateConfig,
  validateText,
  writeSettingsFile,
} from '../src/settings.ts';

const realConfig = () => JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
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
    c.companies[1].ats = 'taleo';
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
    assert.deepEqual(
      errorsOf(validateConfig(c))
        .map((e) => e.path)
        .sort(),
      ['ai.concurrency', 'countries.NL.visa'],
    );
  });

  it('accepts Workday companies and an optional adzuna section, and checks it', () => {
    const c = realConfig();
    c.companies.push({ name: 'Acme', ats: 'workday', token: 'acme/wd3/AcmeCareers' });
    assert.ok(validateConfig(c).ok);
    delete c.adzuna;
    assert.ok(validateConfig(c).ok);
    c.adzuna = { countries: ['nl'], pagesPerSearch: -1 };
    assert.deepEqual(
      errorsOf(validateConfig(c)).map((e) => e.path),
      ['adzuna.pagesPerSearch'],
    );
  });

  it('rejects unknown remote board names with a message naming the valid ones', () => {
    const c = realConfig();
    c.remote.boards = ['himalayas', 'remotve'];
    const errors = errorsOf(validateConfig(c));
    assert.deepEqual(
      errors.map((e) => e.path),
      ['remote.boards[1]'],
    );
    assert.match(errors[0].message, /himalayas.*remotive.*remoteok.*arbeitnow.*adzuna/);
    c.remote.boards = ['himalayas', 'remotive', 'remoteok', 'arbeitnow', 'adzuna'];
    assert.ok(validateConfig(c).ok);
  });

  it('warns about unknown top-level config keys but keeps them', () => {
    const r = validateConfig({ ...realConfig(), minscore: 10 });
    assert.ok(r.ok);
    assert.deepEqual(
      r.warnings.map((w) => w.path),
      ['minscore'],
    );
    assert.match(r.warnings[0].message, /unknown setting/);
    const clean = validateConfig(realConfig());
    assert.ok(clean.ok);
    assert.deepEqual(clean.warnings, []);
  });

  it('rejects something that is not an object', () => {
    assert.deepEqual(
      errorsOf(validateConfig([])).map((e) => e.path),
      ['(root)'],
    );
  });

  it('accepts an optional AI provider with an optional api section, the older names too, and checks them', () => {
    const c = realConfig();
    assert.equal(c.ai.provider, undefined); // the owner's config.json uses the default, claude-cli
    for (const provider of ['claude-cli', 'api', 'openai', 'deepseek']) {
      assert.ok(validateConfig({ ...c, ai: { ...c.ai, provider } }).ok, provider);
    }
    c.ai.provider = 'api';
    c.ai.api = { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', scoreModel: 'llama3.1', responseFormat: 'json_object' };
    c.ai.openai = { scoreModel: 'gpt-4.1-mini' }; // older section, still accepted
    assert.ok(validateConfig(c).ok);
    assert.ok(validateConfig({ ...c, ai: { ...c.ai, api: {} } }).ok); // everything optional
    c.ai.provider = 'gemini';
    c.ai.api = { preset: 'bard', baseUrl: 'not a url', scoreModel: '', responseFormat: 'xml' };
    assert.deepEqual(
      errorsOf(validateConfig(c))
        .map((e) => e.path)
        .sort(),
      ['ai.api.baseUrl', 'ai.api.preset', 'ai.api.responseFormat', 'ai.api.scoreModel', 'ai.provider'],
    );
  });
});

describe('applicant validation', () => {
  it('accepts the example file and an empty object (everything unknown)', () => {
    assert.ok(validateApplicant(example()).ok);
    assert.ok(validateApplicant({}).ok);
    const r = validateApplicant({ noticePeriod: '1 month', expectedSalary: { AE: 25000, remote: null }, petName: 'x' });
    assert.ok(r.ok);
    assert.deepEqual(r.warnings, []); // extra applicant keys are facts for the AI, not typos
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
    assert.throws(
      () => loadSettings('config', f),
      (e: unknown) => {
        assert.ok(e instanceof InvalidSettingsError);
        assert.match(e.message, new RegExp(`Invalid settings file ${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\n  - maxAgeDays: `));
        return true;
      },
    );
    assert.throws(() => loadSettings('applicant', join(dir, 'missing.json')), /missing\.json:\n {2}- \(root\): file not found/);
  });

  it('configFile, applicantFile and masterFile follow JOB_BOT_CONFIG / JOB_BOT_APPLICANT / JOB_BOT_MASTER on every call', () => {
    const saved = { c: process.env.JOB_BOT_CONFIG, a: process.env.JOB_BOT_APPLICANT, m: process.env.JOB_BOT_MASTER };
    try {
      delete process.env.JOB_BOT_CONFIG;
      delete process.env.JOB_BOT_APPLICANT;
      delete process.env.JOB_BOT_MASTER;
      assert.equal(configFile(), path('config.json'));
      assert.equal(applicantFile(), path('cv', 'applicant.json'));
      assert.equal(masterFile(), path('cv', 'master.json'));
      process.env.JOB_BOT_CONFIG = join(dir, 'c.json');
      process.env.JOB_BOT_APPLICANT = join(dir, 'a.json');
      process.env.JOB_BOT_MASTER = join(dir, 'm.json');
      assert.equal(configFile(), join(dir, 'c.json'));
      assert.equal(applicantFile(), join(dir, 'a.json'));
      assert.equal(masterFile(), join(dir, 'm.json'));
    } finally {
      for (const [k, v] of [
        ['JOB_BOT_CONFIG', saved.c],
        ['JOB_BOT_APPLICANT', saved.a],
        ['JOB_BOT_MASTER', saved.m],
      ] as const)
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it('writeSettingsFile writes pretty JSON with a final newline and leaves no temp file', () => {
    const sub = mkdtempSync(join(dir, 'write-'));
    const f = join(sub, 'config.json');
    writeFileSync(f, 'old');
    writeSettingsFile(f, { a: 1 });
    assert.equal(readFileSync(f, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepEqual(readdirSync(sub), ['config.json']);
  });
});
