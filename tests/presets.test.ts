import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.ts';
import { alternatives, applyMarkets, applyStacks, BASE_ROLE_INCLUDE, loadMarkets, loadStacks, pick } from '../src/presets.ts';
import { ensureConfigFile, path, validateConfig } from '../src/settings.ts';

const DEFAULTS = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
const byBoard = (cs: { ats: string; token: string }[]) => cs.map((c) => `${c.ats}:${c.token}`).sort();

describe('presets', () => {
  it('every preset in presets/ loads and is valid', () => {
    assert.deepEqual(
      loadMarkets().map((m) => m.id),
      ['gulf', 'india', 'netherlands', 'pakistan'],
    );
    assert.deepEqual(
      loadStacks().map((s) => s.id),
      ['javascript', 'php-laravel', 'python'],
    );
    for (const m of loadMarkets()) assert.equal(validateConfig(applyMarkets(DEFAULTS, [m])).ok, true, m.id);
    for (const s of loadStacks()) assert.equal(validateConfig(applyStacks(DEFAULTS, [s])).ok, true, s.id);
  });

  it('config.default.json is exactly the gulf, netherlands and pakistan markets with the php-laravel and javascript stacks', () => {
    const markets = pick(loadMarkets(), ['gulf', 'netherlands', 'pakistan'], 'markets');
    const stacks = pick(loadStacks(), ['php-laravel', 'javascript'], 'stacks');
    const built = applyStacks(applyMarkets(DEFAULTS, markets), stacks) as typeof DEFAULTS;
    assert.deepEqual(built.countries, DEFAULTS.countries);
    assert.deepEqual(byBoard(built.companies), byBoard(DEFAULTS.companies));
    assert.equal(built.companies.length, DEFAULTS.companies.length, 'no board in two markets');
    assert.deepEqual(built.linkedin, DEFAULTS.linkedin);
    assert.deepEqual(built.adzuna, DEFAULTS.adzuna);
    assert.deepEqual(built.remote, DEFAULTS.remote);
    assert.equal(built.roleInclude, DEFAULTS.roleInclude);
    assert.equal(built.roleExclude, DEFAULTS.roleExclude);
  });

  it('ships nothing personal: no name, contact or machine path in config.default.json or presets/', () => {
    assert.equal(DEFAULTS.cvFileName, 'resume.pdf');
    assert.equal(DEFAULTS.ai.claudePath, 'claude');
    const texts = [
      readFileSync(path('config.default.json'), 'utf8'),
      ...['markets', 'stacks'].flatMap((k) => readdirSync(path('presets', k)).map((f) => readFileSync(path('presets', k, f), 'utf8'))),
    ];
    for (const t of texts) assert.doesNotMatch(t, /abdul|rehman|@[a-z0-9-]+\.[a-z]|\+92|\/Users\/|C:\\\\/i);
  });

  it('applyMarkets replaces countries, locations, Adzuna countries and boards, and keeps the rest', () => {
    const [gulf, pk] = pick(loadMarkets(), ['gulf', 'PAKISTAN '], 'markets');
    const cfg = applyMarkets(DEFAULTS, [gulf, pk]) as typeof DEFAULTS;
    assert.deepEqual(Object.keys(cfg.countries), ['AE', 'SA', 'PK']);
    assert.deepEqual(cfg.linkedin.locations, ['United Arab Emirates', 'Saudi Arabia', 'Pakistan']);
    assert.deepEqual(cfg.adzuna.countries, []);
    assert.deepEqual(cfg.companies, [...gulf.companies, ...pk.companies]);
    assert.deepEqual(cfg.linkedin.keywords, DEFAULTS.linkedin.keywords);
    assert.equal(cfg.minScore, DEFAULTS.minScore);
    assert.notEqual(cfg, DEFAULTS);
    assert.equal(applyMarkets(DEFAULTS, []), DEFAULTS, 'no preset, no change');
  });

  it('applyMarkets lists a board two markets share once', () => {
    const [nl] = pick(loadMarkets(), ['netherlands'], 'markets');
    const twin = {
      ...nl,
      id: 'twin',
      companies: [{ name: 'Adyen again', ats: nl.companies[0].ats, token: nl.companies[0].token.toUpperCase() }],
    };
    const cfg = applyMarkets(DEFAULTS, [nl, twin]) as typeof DEFAULTS;
    assert.equal(cfg.companies.length, nl.companies.length);
  });

  it('applyStacks: keywords, queries and title words from the stacks; a stack can take its language out of roleExclude', () => {
    const [py] = pick(loadStacks(), ['python'], 'stacks');
    const cfg = applyStacks(DEFAULTS, [py]) as typeof DEFAULTS;
    assert.deepEqual(cfg.linkedin.keywords, ['python', 'django', 'fastapi']);
    assert.deepEqual(cfg.remote.himalayasQueries, ['python', 'django', 'fastapi']);
    assert.equal(cfg.roleInclude, `${BASE_ROLE_INCLUDE}|python|django`);
    assert.doesNotMatch(cfg.roleExclude, /python/);
    assert.match(cfg.roleExclude, /\|golang\|/, 'the other exclusions stay');
    assert.equal(cfg.remote.allow, DEFAULTS.remote.allow);
    assert.equal(new RegExp(cfg.roleExclude, 'i').test('Senior Python Developer'), false);
    assert.equal(new RegExp(cfg.roleInclude, 'i').test('Senior Python Developer'), true);
  });

  it("india: the tech hubs match India, and Pakistan's Hyderabad (Sindh) stays Pakistan", () => {
    const [india, pk] = pick(loadMarkets(), ['india', 'pakistan'], 'markets');
    const inMatch = new RegExp(india.countries.IN.match as string, 'i');
    const pkMatch = new RegExp(pk.countries.PK.match as string, 'i');
    for (const where of [
      'Bengaluru, Karnataka, India',
      'Bangalore',
      'Hyderabad, Telangana',
      'Gurugram',
      'Pune',
      'New Delhi',
      'Remote, India',
    ])
      assert.equal(inMatch.test(where), true, where);
    for (const where of ['Hyderabad, Sindh, Pakistan', 'Hyderabad, Pakistan', 'Indianapolis, Indiana', 'Lahore'])
      assert.equal(inMatch.test(where), false, where);
    assert.equal(pkMatch.test('Hyderabad, Sindh, Pakistan'), true);
    assert.deepEqual(india.adzunaCountries, ['in']);
    assert.ok(india.companies.length >= 10);
  });

  it('pick refuses an unknown id and names the known ones', () => {
    assert.throws(() => pick(loadStacks(), ['cobol'], 'stacks'), /unknown stack preset "cobol" \(known: javascript, php-laravel, python\)/);
  });

  it('alternatives splits on top-level "|" only', () => {
    assert.deepEqual(alternatives('a|\\binterns?(hip)?\\b|(b|c)|[|x]|d\\|e'), ['a', '\\binterns?(hip)?\\b', '(b|c)', '[|x]', 'd\\|e']);
    assert.deepEqual(alternatives(''), []);
  });

  it('a broken preset file is reported with its name and field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-bot-presets-'));
    mkdirSync(join(dir, 'stacks'));
    writeFileSync(join(dir, 'stacks', 'bad.json'), JSON.stringify({ name: 'Bad' }));
    assert.throws(() => loadStacks(dir), /presets\/stacks\/bad\.json: description/);
    assert.deepEqual(loadMarkets(dir), [], 'a missing folder is no presets');
  });
});

describe('config.json from config.default.json', () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-bot-ensure-'));
    const defaults = join(dir, 'config.default.json');
    writeFileSync(defaults, '{"minScore": 1}\n');
    return { home: join(dir, 'config.json'), defaults, dir };
  };

  it('a fresh clone gets a copy of the defaults', () => {
    const { home, defaults } = setup();
    assert.equal(ensureConfigFile(home, defaults, home), true);
    assert.equal(readFileSync(home, 'utf8'), '{"minScore": 1}\n');
  });

  it('an existing config.json is never overwritten', () => {
    const { home, defaults } = setup();
    writeFileSync(home, '{"minScore": 9}');
    assert.equal(ensureConfigFile(home, defaults, home), false);
    assert.equal(readFileSync(home, 'utf8'), '{"minScore": 9}');
  });

  it('a missing JOB_BOT_CONFIG file stays missing, so a typo in it is still reported', () => {
    const { home, defaults, dir } = setup();
    const other = join(dir, 'other.json');
    assert.equal(ensureConfigFile(other, defaults, home), false);
    assert.equal(existsSync(other), false);
  });
});
