import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import './helpers.ts';
import { claudePathHint, runSetup } from '../src/commands/setup.ts';
import { effectiveRemoteRules } from '../src/regions.ts';
import { validateApplicant, validateConfig } from '../src/settings.ts';

const ROOT = join(import.meta.dirname, '..');
const OWNER_APPLICANT = join(import.meta.dirname, 'fixtures', 'applicant-owner.json');
const OWNER_MASTER = JSON.parse(readFileSync(join(ROOT, 'cv', 'master.json'), 'utf8'));
const JANE_MASTER = JSON.parse(readFileSync(join(ROOT, 'cv', 'master.example.json'), 'utf8'));
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

/** Temp copies of config.json (and optionally an applicant.json): the wizard never touches the real files. */
function files(applicant?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'job-bot-setup-'));
  const config = join(dir, 'config.json');
  copyFileSync(join(ROOT, 'config.default.json'), config);
  const app = join(dir, 'applicant.json');
  if (applicant) copyFileSync(applicant, app);
  return { config, applicant: app };
}

/** Runs the wizard with these answer lines; returns its result and everything it printed. */
async function run(answers: string[], f: { config: string; applicant: string }, master: object) {
  const output = new PassThrough();
  let printed = '';
  output.on('data', (d) => (printed += d));
  const ok = await runSetup({ input: Readable.from([answers.map((a) => `${a}\n`).join('')]), output }, { ...f, master });
  return { ok, printed };
}

// Answers in question order for a new user, Jane Doe in Lisbon, after cloning (owner's config.json, no applicant.json).
const JANE = [
  '', // full name: from her CV
  '', // email: from her CV
  '-', // phone: cleared
  '', // LinkedIn: from her CV
  'Lisbon',
  'Portugal',
  'pt',
  'GMT+0',
  'English, Portuguese, Dutch',
  'Portuguese citizen',
  'Only outside the EU',
  'Yes',
  '', // market presets: none, keep config.json
  'NL, DE', // target countries: keep NL, drop AE/SA, add DE
  '', // NL name
  '', // NL pattern
  '', // NL visa route
  'n', // NL: no visa needed (EU)
  'Germany',
  'berlin|munich|germany',
  'employer',
  'n',
  'y', // remote jobs
  '', // remote from: her country
  '', // code
  '', // allow: automatic for PT
  '', // deny: automatic for PT
  'Amsterdam, Berlin', // LinkedIn locations
  '', // stack presets: none
  '', // Claude CLI or API key: the default, claude-cli
  '/usr/local/bin/claude',
  '', // CV file name
  'y', // save
];

describe('setup wizard', () => {
  it('a new user: fills in the profile and the markets, validated, from the defaults shown', async () => {
    const f = files();
    const { ok, printed } = await run(JANE, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    const app = json(f.applicant);
    assert.equal(validateApplicant(app).ok, true);
    assert.deepEqual(
      [app.fullName, app.email, app.phone, app.linkedin, app.city, app.country, app.countryCode, app.utcOffset, app.currentLocation],
      [
        'Jane Doe',
        'jane.doe@example.com',
        null,
        'https://www.linkedin.com/in/jane-doe-example/',
        'Lisbon',
        'Portugal',
        'PT',
        'GMT+0',
        'Lisbon, Portugal',
      ],
    );
    assert.equal(app.languages, 'English, Portuguese, Dutch');
    assert.equal(app.willingToRelocate, 'Yes');
    assert.equal(app.nationality, null); // the rest stays unknown, never the example person's values
    const cfg = json(f.config);
    assert.equal(validateConfig(cfg).ok, true);
    assert.deepEqual(Object.keys(cfg.countries), ['NL', 'DE']);
    assert.equal(cfg.countries.NL.needsVisa, false);
    assert.equal(cfg.countries.NL.visa, 'ind-register'); // kept
    assert.deepEqual(cfg.countries.DE, { name: 'Germany', visa: 'employer', match: 'berlin|munich|germany', needsVisa: false });
    assert.equal(cfg.remote.from, 'Portugal');
    assert.equal(cfg.remote.fromCode, 'PT');
    assert.equal(cfg.linkedin.remoteFrom, 'Portugal');
    // No hand-written region patterns: they are computed for Portugal.
    assert.deepEqual([cfg.remote.allow, cfg.remote.deny, cfg.remote.flag], [undefined, undefined, undefined]);
    const rules = effectiveRemoteRules(cfg.remote, cfg.remote.fromCode, cfg.remote.from);
    assert.match(rules.allow, /\|portugal\|/);
    assert.doesNotMatch(rules.allow, /pakistan/);
    assert.doesNotMatch(rules.deny, /portugal/);
    assert.match(rules.deny, /\|spain\|/);
    assert.match(printed, /Remote regions that include you \(regular expression; Enter = automatic for PT\): /);
    assert.deepEqual(cfg.linkedin.locations, ['Amsterdam', 'Berlin']);
    assert.equal(cfg.ai.claudePath, '/usr/local/bin/claude');
    assert.equal(cfg.ai.provider, undefined); // the default is not written
    assert.equal(cfg.cvFileName, 'jane_doe_resume.pdf'); // the shipped resume.pdf is replaced by one from her name
    assert.equal(cfg.companies.length, json(join(ROOT, 'config.default.json')).companies.length);
    // Defaults are shown before they are kept.
    assert.match(printed, /Full name \[Jane Doe\]: /);
    assert.match(printed, /Target countries .* \[AE, SA, NL, PK\]: /);
    assert.match(printed, /Remote work from which country \(config\.json had Pakistan\) \[Portugal\]: /);
    assert.match(printed, /Its two-letter code \(config\.json had PK\) \[PT\]: /);
    assert.match(printed, /Saved\./);
    // Next steps that differ from a plain clone: Chrome's headless shell for PDFs and the scheduler for this OS.
    assert.match(printed, /npx playwright-core install chromium-headless-shell/);
    assert.match(printed, /npm run bot -- schedule:print/);
  });

  it('presets: a market and a stack replace the lists they cover, shown first and then as the defaults', async () => {
    const f = files();
    const answers = [...JANE];
    answers.splice(JANE.indexOf('NL, DE') - 1, 2, 'netherlands', ''); // market preset, then Enter keeps its countries
    answers.splice(answers.indexOf('Amsterdam, Berlin'), 2, '', 'python'); // its LinkedIn locations, then the stack
    // NL from the preset has no visa questions answered differently: Enter keeps them.
    answers.splice(answers.indexOf('n'), 1, '');
    answers.splice(answers.indexOf('Germany'), 4);
    const { ok, printed } = await run(answers, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    const cfg = json(f.config);
    assert.equal(validateConfig(cfg).ok, true);
    assert.deepEqual(Object.keys(cfg.countries), ['NL']);
    assert.deepEqual(cfg.linkedin.locations, ['Netherlands']);
    assert.deepEqual(cfg.adzuna.countries, ['nl']);
    assert.ok(cfg.companies.some((c: { name: string }) => c.name === 'Adyen'));
    assert.ok(!cfg.companies.some((c: { name: string }) => c.name === 'Careem'), 'Gulf boards are gone');
    assert.deepEqual(cfg.linkedin.keywords, ['python', 'django', 'fastapi']);
    assert.match(cfg.roleInclude, /\|python\|django$/);
    assert.doesNotMatch(cfg.roleExclude, /python/);
    assert.match(printed, /netherlands: Onsite jobs in the Netherlands/);
    assert.match(printed, /python: Python back-end roles/);
    assert.match(printed, /Target countries .* \[NL\]: /);
  });

  it('presets: an unknown name is refused with the known ones, and asked again', async () => {
    const f = files();
    const answers = [...JANE];
    answers.splice(JANE.indexOf('NL, DE') - 1, 1, 'mars', '');
    const { ok, printed } = await run(answers, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.match(printed, /unknown market preset "mars" \(known: gulf, india, netherlands, pakistan\)/);
  });

  it('tells how to find the Claude CLI on each OS', () => {
    assert.equal(claudePathHint('darwin'), '`which claude`');
    assert.equal(claudePathHint('linux'), '`which claude`');
    assert.match(claudePathHint('win32'), /^`where claude`; use the claude\.exe .*not claude\.cmd$/);
  });

  it('the owner: pressing Enter everywhere keeps config.json and the profile as they are', async () => {
    const f = files(OWNER_APPLICANT);
    writeFileSync(f.config, JSON.stringify({ ...json(f.config), cvFileName: 'abdulrehman_dar_resume.pdf' }));
    const before = json(f.config);
    const { ok, printed } = await run(Array(40).fill(''), f, OWNER_MASTER);
    assert.equal(ok, true, printed);
    assert.deepEqual(json(f.config), before);
    const app = json(f.applicant);
    const old = json(OWNER_APPLICANT);
    for (const [k, v] of Object.entries(old)) assert.deepEqual(app[k], v, k);
    // Name and contact were taken from the CV, shown as defaults.
    assert.equal(app.fullName, 'Abdul Rehman Dar');
    assert.match(printed, /City you live in \[Lahore\]: /);
    assert.match(printed, /Its two-letter country code \(ISO\), e\.g\. PT \[PK\]: /);
    assert.match(printed, /Remote work from which country \[Pakistan\]: /);
    assert.match(printed, /Claude CLI or API key \(claude-cli \/ api\) \[claude-cli\]: /);
  });

  it('hand-written remote region patterns stay while the country stays, and go when it changes', async () => {
    const custom = { allow: 'worldwide|pakistan', deny: 'india', flag: 'emea' };
    const owner = files(OWNER_APPLICANT);
    writeFileSync(owner.config, JSON.stringify({ ...json(owner.config), remote: { ...json(owner.config).remote, ...custom } }));
    const kept = await run(Array(40).fill(''), owner, OWNER_MASTER);
    assert.equal(kept.ok, true, kept.printed);
    assert.deepEqual(
      [json(owner.config).remote.allow, json(owner.config).remote.deny, json(owner.config).remote.flag],
      Object.values(custom),
    );
    assert.match(
      kept.printed,
      /Remote regions that include you \(regular expression; Enter = automatic for PK\) \[worldwide\|pakistan\]: /,
    );
    // Jane moves the remote country to Portugal: Pakistan's patterns would be wrong for her, so they are not offered.
    const jane = files();
    writeFileSync(jane.config, JSON.stringify({ ...json(jane.config), remote: { ...json(jane.config).remote, ...custom } }));
    const moved = await run(JANE, jane, JANE_MASTER);
    assert.equal(moved.ok, true, moved.printed);
    const remote = json(jane.config).remote;
    assert.deepEqual([remote.allow, remote.deny, remote.flag], [undefined, undefined, undefined]);
  });

  it('a typed region pattern is checked and saved as written', async () => {
    const f = files();
    const answers = [...JANE];
    const at = answers.indexOf('Amsterdam, Berlin') - 2;
    answers.splice(at, 2, '(broken', 'worldwide|portugal|europe', '');
    const { ok, printed } = await run(answers, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.equal(json(f.config).remote.allow, 'worldwide|portugal|europe');
    assert.equal(json(f.config).remote.deny, undefined);
    assert.match(printed, /not a valid regular expression|Invalid regular expression/i);
  });

  /** JANE's answers with the Claude CLI question and path replaced by these AI answers. */
  const withAi = (...ai: string[]) => {
    const answers = [...JANE];
    answers.splice(answers.indexOf('/usr/local/bin/claude') - 1, 2, ...ai);
    return answers;
  };

  it('API key, auto-detected: saves provider "api" without a preset, says to put AI_API_KEY in .env, never asks for it', async () => {
    const f = files();
    const { ok, printed } = await run(withAi('api', ''), f, JANE_MASTER);
    assert.equal(ok, true, printed);
    const cfg = json(f.config);
    assert.equal(validateConfig(cfg).ok, true);
    assert.equal(cfg.ai.provider, 'api');
    assert.equal(cfg.ai.api, undefined); // auto: nothing to store
    assert.equal(cfg.ai.claudePath, json(join(ROOT, 'config.default.json')).ai.claudePath); // kept for switching back
    assert.match(printed, /Which provider \(auto, openai, deepseek, anthropic, .*custom; auto = from the key\) \[auto\]: /);
    assert.match(printed, /Put your API key in \.env \(in the job-bot folder\) as AI_API_KEY=\.\.\./);
    assert.match(printed, /sk-ant- Anthropic, gsk_ Groq, sk-or- OpenRouter, AIza Gemini, other sk- OpenAI/);
    assert.match(printed, /for DeepSeek, choose deepseek here/);
    assert.doesNotMatch(printed, /Path to the Claude Code CLI/);
    assert.doesNotMatch(readFileSync(f.config, 'utf8'), /API_KEY|sk-/);
  });

  it('API key with a preset: stores it and shows its models', async () => {
    const f = files();
    const { ok, printed } = await run(withAi('API', 'Anthropic'), f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.deepEqual(json(f.config).ai.api, { preset: 'anthropic' });
    assert.match(printed, /Anthropic models: claude-haiku-5-5 for scoring and claude-sonnet-5-5 for writing/);
  });

  it('ollama needs no key; custom asks for its base URL and models', async () => {
    let f = files();
    let res = await run(withAi('api', 'ollama'), f, JANE_MASTER);
    assert.equal(res.ok, true, res.printed);
    assert.match(res.printed, /Ollama needs no key/);
    assert.doesNotMatch(res.printed, /AI_API_KEY=/);
    f = files();
    res = await run(withAi('api', 'custom', 'ftp://x', 'https://llm.example.test/v1', 'small', 'big'), f, JANE_MASTER);
    assert.equal(res.ok, true, res.printed);
    assert.match(res.printed, /must start with https:\/\//);
    assert.deepEqual(json(f.config).ai.api, {
      preset: 'custom',
      baseUrl: 'https://llm.example.test/v1',
      scoreModel: 'small',
      letterModel: 'big',
    });
  });

  it('a config with the older "deepseek" provider becomes "api" with that preset, keeping its models', async () => {
    const f = files();
    const cfg = json(f.config);
    writeFileSync(
      f.config,
      JSON.stringify({ ...cfg, ai: { ...cfg.ai, provider: 'deepseek', deepseek: { letterModel: 'deepseek-reasoner' } } }),
    );
    const { ok, printed } = await run(withAi('', ''), f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.match(printed, /Claude CLI or API key \(claude-cli \/ api\) \[api\]: /);
    const ai = json(f.config).ai;
    assert.equal(ai.provider, 'api');
    assert.deepEqual(ai.api, { preset: 'deepseek', letterModel: 'deepseek-reasoner' });
    assert.equal(ai.deepseek, undefined);
  });

  it('asks again for an unknown answer', async () => {
    const f = files();
    const answers = [...JANE];
    answers.splice(answers.indexOf('/usr/local/bin/claude') - 1, 1, 'gemini', 'claude-cli');
    const { ok, printed } = await run(answers, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.match(printed, / {2}claude-cli or api/);
    assert.equal(json(f.config).ai.provider, undefined); // claude-cli is the default, so config.json stays as it was
  });

  it('asks again after an invalid answer', async () => {
    const f = files();
    const answers = [...JANE];
    answers.splice(1, 1, 'not-an-email', 'jane@example.org');
    answers.splice(7, 1, 'Portugal', 'PT'); // code question: a name first, then the code
    const { ok, printed } = await run(answers, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.match(printed, /not an email address/);
    assert.match(printed, /two letters, e\.g\. PT/);
    assert.equal(json(f.applicant).email, 'jane@example.org');
    assert.equal(json(f.applicant).countryCode, 'PT');
  });

  it('writes nothing when the answer to save is no', async () => {
    const f = files();
    const before = readFileSync(f.config, 'utf8');
    const { ok, printed } = await run([...JANE.slice(0, -1), 'n'], f, JANE_MASTER);
    assert.equal(ok, false);
    assert.match(printed, /Nothing saved\./);
    assert.equal(existsSync(f.applicant), false);
    assert.equal(readFileSync(f.config, 'utf8'), before);
  });

  it('writes nothing when the input ends before a required answer', async () => {
    const f = files();
    await assert.rejects(run(['', '', '', '', 'Lisbon', 'Portugal'], f, JANE_MASTER), /no valid answer for "Its two-letter country code/);
    assert.equal(existsSync(f.applicant), false);
  });

  it('stops when config.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'job-bot-setup-'));
    const { ok, printed } = await run([], { config: join(dir, 'config.json'), applicant: join(dir, 'a.json') }, JANE_MASTER);
    assert.equal(ok, false);
    assert.match(printed, /missing or not a JSON object/);
  });

  it('runs as `bot setup` on stdin, without a database', () => {
    const f = files();
    const out = execFileSync(process.execPath, ['--no-warnings', join(ROOT, 'src', 'cli.ts'), 'setup'], {
      input: JANE.map((a) => `${a}\n`).join(''),
      env: {
        ...process.env,
        JOB_BOT_CONFIG: f.config,
        JOB_BOT_APPLICANT: f.applicant,
        JOB_BOT_MASTER: join(ROOT, 'cv', 'master.example.json'),
        DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
      },
      encoding: 'utf8',
    });
    assert.match(out, /Saved\./);
    assert.equal(json(f.applicant).fullName, 'Jane Doe');
  });
});
