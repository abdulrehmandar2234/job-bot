import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import './helpers.ts';
import { defaultAllow, defaultDeny, runSetup } from '../src/commands/setup.ts';
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
  copyFileSync(join(ROOT, 'config.json'), config);
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
  '', // allow: default for Portugal
  '', // deny: without Portugal
  'Amsterdam, Berlin', // LinkedIn locations
  '', // AI provider: the default, claude-cli
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
    assert.match(cfg.remote.allow, /\|portugal\|/);
    assert.doesNotMatch(cfg.remote.allow, /pakistan/);
    assert.doesNotMatch(cfg.remote.deny, /portugal/);
    assert.match(cfg.remote.deny, /\|spain\|/);
    assert.deepEqual(cfg.linkedin.locations, ['Amsterdam', 'Berlin']);
    assert.equal(cfg.ai.claudePath, '/usr/local/bin/claude');
    assert.equal(cfg.ai.provider, undefined); // the default is not written
    assert.equal(cfg.cvFileName, 'abdulrehman_dar_resume.pdf'); // an existing value is only ever the default
    assert.equal(cfg.companies.length, json(join(ROOT, 'config.json')).companies.length);
    // Defaults are shown before they are kept.
    assert.match(printed, /Full name \[Jane Doe\]: /);
    assert.match(printed, /Target countries .* \[AE, SA, NL\]: /);
    assert.match(printed, /Remote work from which country \(config\.json had Pakistan\) \[Portugal\]: /);
    assert.match(printed, /Its two-letter code \(config\.json had PK\) \[PT\]: /);
    assert.match(printed, /Saved\./);
  });

  it('the owner: pressing Enter everywhere keeps config.json and the profile as they are', async () => {
    const f = files(OWNER_APPLICANT);
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
    assert.match(printed, /AI provider \[claude-cli\]: /);
  });

  for (const [provider, keyEnv, scoreModel] of [
    ['openai', 'OPENAI_API_KEY', 'gpt-4o-mini'],
    ['DeepSeek', 'DEEPSEEK_API_KEY', 'deepseek-chat'],
  ] as const) {
    it(`an API provider (${provider}): saved, says which env var goes in .env, never asks for the key`, async () => {
      const f = files();
      const answers = [...JANE];
      answers.splice(answers.indexOf('/usr/local/bin/claude') - 1, 2, provider); // no Claude CLI path question
      const { ok, printed } = await run(answers, f, JANE_MASTER);
      assert.equal(ok, true, printed);
      const cfg = json(f.config);
      assert.equal(validateConfig(cfg).ok, true);
      assert.equal(cfg.ai.provider, provider.toLowerCase());
      assert.equal(cfg.ai.claudePath, json(join(ROOT, 'config.json')).ai.claudePath); // kept for switching back
      assert.match(printed, new RegExp(`API key in \\.env \\(in the job-bot folder\\) as ${keyEnv}=`));
      assert.match(printed, new RegExp(`Models: ${scoreModel} for scoring`));
      assert.doesNotMatch(printed, /Path to the Claude Code CLI/);
      assert.doesNotMatch(readFileSync(f.config, 'utf8'), /API_KEY|sk-/);
    });
  }

  it('asks again for an unknown AI provider', async () => {
    const f = files();
    const answers = [...JANE];
    answers.splice(answers.indexOf('/usr/local/bin/claude') - 1, 1, 'gemini', 'claude-cli');
    const { ok, printed } = await run(answers, f, JANE_MASTER);
    assert.equal(ok, true, printed);
    assert.match(printed, /claude-cli, openai, deepseek/);
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

  it('remote region patterns follow the remote-from country', () => {
    assert.equal(defaultAllow('worldwide|pakistan|asia', 'Pakistan'), 'worldwide|pakistan|asia');
    assert.equal(defaultAllow('worldwide|pakistan', 'India'), 'worldwide|anywhere|global|india|emea|international');
    assert.equal(defaultDeny('\\b(us|usa)\\b|india|philippines', 'India'), '\\b(us|usa)\\b|philippines');
    assert.equal(defaultDeny('canada|\\bindia\\b', 'India'), 'canada');
    assert.equal(defaultDeny('canada', ''), 'canada');
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
