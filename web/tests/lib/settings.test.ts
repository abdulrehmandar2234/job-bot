import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  AI_PROVIDERS as BOT_AI_PROVIDERS,
  API_DEFAULTS as BOT_API_DEFAULTS,
  ATS as BOT_ATS,
  KEY_ENV as BOT_KEY_ENV,
  PROVIDER_NAME as BOT_PROVIDER_NAME,
} from '../../../src/settings';
import { BOT_ROOT } from '@/lib/bot';
import { aiKeyStatus, applicantFile, configFile, readApplicant, readConfig } from '@/lib/settings';
import {
  AI_PROVIDERS,
  API_DEFAULTS,
  ATS,
  errorsFor,
  get,
  KEY_ENV,
  mergeApplicant,
  mergeConfig,
  PROVIDER_NAME,
  salaryKeys,
} from '@/lib/settings-form';

const dir = mkdtempSync(join(tmpdir(), 'job-bot-web-settings-'));
const tmp = (name: string, content: string) => {
  const f = join(dir, name);
  writeFileSync(f, content);
  return f;
};
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('settings files', () => {
  it('defaults to the files in the bot root', () => {
    vi.stubEnv('JOB_BOT_CONFIG', '');
    vi.stubEnv('JOB_BOT_APPLICANT', '');
    expect(configFile()).toBe(join(BOT_ROOT, 'config.json'));
    expect(applicantFile()).toBe(join(BOT_ROOT, 'cv', 'applicant.json'));
  });

  it('reads the files named by JOB_BOT_CONFIG / JOB_BOT_APPLICANT', () => {
    vi.stubEnv('JOB_BOT_CONFIG', tmp('c.json', '{"minScore": 7}'));
    vi.stubEnv('JOB_BOT_APPLICANT', tmp('a.json', '{"nationality": "Pakistani"}'));
    expect(readConfig()).toMatchObject({ file: join(dir, 'c.json'), text: '{"minScore": 7}', data: { minScore: 7 }, error: null });
    expect(readApplicant()).toMatchObject({ data: { nationality: 'Pakistani' }, example: false });
  });

  it('falls back to applicant.example.json when applicant.json is missing', () => {
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    const a = readApplicant();
    expect(a.example).toBe(true);
    expect(a.file).toBe(join(BOT_ROOT, 'cv', 'applicant.example.json'));
    expect(a.data).toEqual(JSON.parse(readFileSync(a.file, 'utf8')));
  });

  it('reports a missing file, invalid JSON and a non-object instead of throwing', () => {
    vi.stubEnv('JOB_BOT_CONFIG', join(dir, 'nope.json'));
    expect(readConfig()).toMatchObject({ data: null, error: 'file not found', text: '' });
    vi.stubEnv('JOB_BOT_CONFIG', tmp('bad.json', '{ nope'));
    expect(readConfig()).toMatchObject({ data: null, text: '{ nope', error: expect.stringContaining('invalid JSON') });
    vi.stubEnv('JOB_BOT_CONFIG', tmp('arr.json', '[1]'));
    expect(readConfig()).toMatchObject({ data: null, error: 'not a JSON object' });
  });

  it('has the same AI providers, names, key variables and defaults as the bot', () => {
    expect([...AI_PROVIDERS]).toEqual([...BOT_AI_PROVIDERS]);
    expect(PROVIDER_NAME).toEqual(BOT_PROVIDER_NAME);
    expect(KEY_ENV).toEqual(BOT_KEY_ENV);
    expect(API_DEFAULTS).toEqual(BOT_API_DEFAULTS);
  });

  it('has the same ATS list as the bot', () => {
    expect([...ATS]).toEqual([...BOT_ATS]);
  });
});

const CONFIG = {
  cvFileName: 'cv.pdf',
  minScore: 45,
  maxAgeDays: 14,
  autoCvVersions: true,
  roleInclude: 'dev',
  roleExclude: 'senior',
  futureKey: { keep: 1 },
  ai: { enabled: true, claudePath: '/bin/claude', scoreModel: 'haiku', letterModel: 'sonnet', maxScorePerRun: 80, concurrency: 2 },
  linkedin: { enabled: true, keywords: ['php'], locations: ['Dubai'], remoteFrom: 'Pakistan', pagesPerSearch: 2 },
  remote: { enabled: true, boards: ['himalayas'], himalayasQueries: ['php'], allow: 'a', deny: 'd', flag: 'f' },
  countries: { AE: { name: 'UAE', visa: 'employer', match: 'dubai' } },
  companies: [
    { name: 'Elastic', ats: 'greenhouse', token: 'elastic', indName: 'elasticsearch B.V.' },
    { name: 'Old', ats: 'lever', token: 'old' },
  ],
};

const configForm = (over: Record<string, string> = {}) =>
  form({
    minScore: '50',
    maxAgeDays: '10',
    roleInclude: ' dev|eng ',
    roleExclude: 'senior',
    'linkedin.enabled': 'on',
    'linkedin.keywords': 'php\n  laravel \n\n',
    'linkedin.locations': 'Dubai',
    'linkedin.remoteFrom': 'Pakistan',
    'linkedin.pagesPerSearch': '3',
    'remote.boards': 'himalayas\nremotive',
    'remote.himalayasQueries': 'php',
    'remote.allow': 'a',
    'remote.deny': 'd',
    'remote.flag': 'f',
    'ai.enabled': 'on',
    'ai.scoreModel': 'haiku',
    'ai.letterModel': 'opus',
    'ai.maxScorePerRun': '40',
    'countries.AE.match': 'dubai|abu dhabi',
    'companies[0].orig': '0',
    'companies[0].name': 'Elastic NV',
    'companies[0].ats': 'greenhouse',
    'companies[0].token': 'elastic',
    'companies[1].orig': '-1',
    'companies[1].name': 'New Co',
    'companies[1].ats': 'ashby',
    'companies[1].token': 'newco',
    ...over,
  });

describe('mergeConfig', () => {
  it('applies the form, keeping keys the form does not show', () => {
    const cfg = mergeConfig(CONFIG, configForm());
    expect(cfg).toMatchObject({
      cvFileName: 'cv.pdf',
      futureKey: { keep: 1 },
      minScore: 50,
      maxAgeDays: 10,
      roleInclude: 'dev|eng',
      autoCvVersions: false, // unchecked
      ai: { enabled: true, claudePath: '/bin/claude', letterModel: 'opus', maxScorePerRun: 40, concurrency: 2 },
      linkedin: { keywords: ['php', 'laravel'], pagesPerSearch: 3 },
      remote: { enabled: false, boards: ['himalayas', 'remotive'] },
      countries: { AE: { name: 'UAE', visa: 'employer', match: 'dubai|abu dhabi' } },
    });
    // Row 0 was Elastic (keeps indName), "Old" was removed, row 1 is new.
    expect(cfg.companies).toEqual([
      { name: 'Elastic NV', ats: 'greenhouse', token: 'elastic', indName: 'elasticsearch B.V.' },
      { name: 'New Co', ats: 'ashby', token: 'newco' },
    ]);
    expect(CONFIG.minScore).toBe(45); // the input is not changed
  });

  it('passes empty or non-numeric numbers on for the validator to report', () => {
    const cfg = mergeConfig(CONFIG, configForm({ minScore: '', maxAgeDays: 'abc' }));
    expect(cfg.minScore).toBeNull();
    expect(cfg.maxAgeDays).toBe('abc');
  });

  it('saves ai.alertStrong as a checkbox', () => {
    expect(get(mergeConfig(CONFIG, configForm({ 'ai.alertStrong': 'on' })), 'ai.alertStrong')).toBe(true);
    expect(get(mergeConfig(CONFIG, configForm()), 'ai.alertStrong')).toBe(false);
  });

  it('leaves adzuna alone when the form has no adzuna fields', () => {
    const current = { ...CONFIG, adzuna: { countries: ['nl'], pagesPerSearch: 2 } };
    expect(mergeConfig(current, configForm()).adzuna).toEqual({ countries: ['nl'], pagesPerSearch: 2 });
    expect('adzuna' in mergeConfig(CONFIG, configForm())).toBe(false);
  });

  it('does not create an adzuna section from empty fields', () => {
    const cfg = mergeConfig(CONFIG, configForm({ 'adzuna.countries': ' \n', 'adzuna.keywords': '', 'adzuna.pagesPerSearch': '' }));
    expect('adzuna' in cfg).toBe(false);
  });

  it('removes the adzuna section when every field is cleared (the bot then uses its defaults)', () => {
    const current = { ...CONFIG, adzuna: { countries: ['nl'], pagesPerSearch: 2 } };
    const cfg = mergeConfig(current, configForm({ 'adzuna.countries': '', 'adzuna.keywords': '', 'adzuna.pagesPerSearch': '' }));
    expect('adzuna' in cfg).toBe(false);
  });

  it('saves adzuna countries and pages, with keywords only when given, keeping unknown adzuna keys', () => {
    const current = { ...CONFIG, adzuna: { countries: ['nl'], keywords: ['old'], pagesPerSearch: 2, extra: 1 } };
    const cfg = mergeConfig(current, configForm({ 'adzuna.countries': 'nl\n de ', 'adzuna.keywords': '', 'adzuna.pagesPerSearch': '3' }));
    expect(cfg.adzuna).toEqual({ countries: ['nl', 'de'], pagesPerSearch: 3, extra: 1 });
    const withKeywords = mergeConfig(
      CONFIG,
      configForm({ 'adzuna.countries': 'nl', 'adzuna.keywords': 'php\nlaravel', 'adzuna.pagesPerSearch': '1' }),
    );
    expect(withKeywords.adzuna).toEqual({ countries: ['nl'], keywords: ['php', 'laravel'], pagesPerSearch: 1 });
  });

  it('passes a half-filled adzuna section on for the validator to report', () => {
    const cfg = mergeConfig(CONFIG, configForm({ 'adzuna.countries': 'nl', 'adzuna.pagesPerSearch': '' }));
    expect(cfg.adzuna).toEqual({ countries: ['nl'], pagesPerSearch: null });
  });

  it('ignores country fields for countries that are not in the file', () => {
    const cfg = mergeConfig(CONFIG, configForm({ 'countries.XX.match': 'x', 'countries.__proto__.match': 'x' }));
    expect(Object.keys(cfg.countries as object)).toEqual(['AE']);
  });
});

describe('mergeConfig: AI provider', () => {
  it('keeps a missing provider missing when the default (claude-cli) is chosen, or when the form has no select', () => {
    expect(get(mergeConfig(CONFIG, configForm()), 'ai.provider')).toBeUndefined();
    expect(get(mergeConfig(CONFIG, configForm({ 'ai.provider': 'claude-cli' })), 'ai.provider')).toBeUndefined();
  });

  it('saves another provider, and a switch back when the file named one', () => {
    const openai = mergeConfig(CONFIG, configForm({ 'ai.provider': 'openai' }));
    expect(get(openai, 'ai.provider')).toBe('openai');
    expect(get(mergeConfig(openai, configForm({ 'ai.provider': 'claude-cli' })), 'ai.provider')).toBe('claude-cli');
    expect(get(mergeConfig(openai, configForm()), 'ai.provider')).toBe('openai'); // no select in the form: kept
  });

  it('saves per-provider models; cleared fields are removed without leaving an empty section', () => {
    const cfg = mergeConfig(
      CONFIG,
      configForm({ 'ai.openai.scoreModel': ' gpt-4.1-mini ', 'ai.openai.letterModel': '', 'ai.deepseek.scoreModel': '' }),
    );
    expect(get(cfg, 'ai.openai')).toEqual({ scoreModel: 'gpt-4.1-mini' });
    expect('deepseek' in (cfg.ai as object)).toBe(false);
    const cleared = mergeConfig(cfg, configForm({ 'ai.openai.scoreModel': '', 'ai.openai.letterModel': '', 'ai.openai.baseUrl': '' }));
    expect('openai' in (cleared.ai as object)).toBe(false);
    expect(cleared.ai).toMatchObject({ claudePath: '/bin/claude', concurrency: 2 });
  });

  it('keeps per-provider keys the form does not show', () => {
    const current = { ...CONFIG, ai: { ...(CONFIG.ai as object), deepseek: { scoreModel: 'x', future: 1 } } };
    const cfg = mergeConfig(current, configForm({ 'ai.deepseek.scoreModel': '' }));
    expect(get(cfg, 'ai.deepseek')).toEqual({ future: 1 });
  });
});

describe('aiKeyStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const keys = (envFile: string, env: Record<string, string> = {}) => {
    vi.stubEnv('JOB_BOT_ENV_FILE', tmp('env-file', envFile));
    vi.stubEnv('OPENAI_API_KEY', env.OPENAI_API_KEY ?? '');
    vi.stubEnv('DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY ?? '');
    return aiKeyStatus();
  };

  it("checks the bot's env file by name, ignoring empty values and comments", () => {
    expect(keys('ADZUNA_APP_ID=1\nOPENAI_API_KEY=sk-secret\nDEEPSEEK_API_KEY=\n')).toEqual({ openai: true, deepseek: false });
    expect(keys('# OPENAI_API_KEY=sk-secret\nDEEPSEEK_API_KEY=""\n')).toEqual({ openai: false, deepseek: false });
    expect(keys('export DEEPSEEK_API_KEY="ds-secret"\n')).toEqual({ openai: false, deepseek: true });
  });

  it('also counts a key in the environment the bot inherits, and a missing env file', () => {
    vi.stubEnv('JOB_BOT_ENV_FILE', join(dir, 'no-such-env'));
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-secret');
    expect(aiKeyStatus()).toEqual({ openai: false, deepseek: true });
  });

  it('returns booleans only, never a value', () => {
    expect(JSON.stringify(keys('OPENAI_API_KEY=sk-secret\n'))).not.toContain('sk-secret');
  });
});

describe('mergeConfig: target markets', () => {
  it('sets the visa need and label per country, and the remote-from country', () => {
    const cfg = mergeConfig(
      { ...CONFIG, remote: { ...CONFIG.remote, from: 'Pakistan', fromCode: 'PK' } },
      configForm({
        'countries.AE.needsVisa': 'on',
        'countries.AE.label': ' Emirates ',
        'remote.from': ' Portugal ',
        'remote.fromCode': 'pt',
      }),
    );
    expect(cfg.countries).toEqual({ AE: { name: 'UAE', visa: 'employer', match: 'dubai|abu dhabi', needsVisa: true, label: 'Emirates' } });
    expect(cfg.remote).toMatchObject({ from: 'Portugal', fromCode: 'PT' });
  });

  it('an unchecked visa box means no visa; empty optional fields remove their key', () => {
    const cfg = mergeConfig(
      {
        ...CONFIG,
        countries: { AE: { ...CONFIG.countries.AE, label: 'x' } },
        remote: { ...CONFIG.remote, from: 'Pakistan', fromCode: 'PK' },
      },
      configForm({ 'countries.AE.label': '', 'remote.from': '', 'remote.fromCode': ' ' }),
    );
    expect(cfg.countries).toEqual({ AE: { name: 'UAE', visa: 'employer', match: 'dubai|abu dhabi', needsVisa: false } });
    expect(cfg.remote).not.toHaveProperty('from');
    expect(cfg.remote).not.toHaveProperty('fromCode');
  });

  it('keeps remote.from when the form does not show it', () => {
    const cfg = mergeConfig({ ...CONFIG, remote: { ...CONFIG.remote, from: 'Pakistan' } }, configForm());
    expect(cfg.remote).toMatchObject({ from: 'Pakistan' });
  });

  it('salary keys follow the target countries', () => {
    expect(salaryKeys(CONFIG)).toEqual(['AE', 'remote']);
    expect(salaryKeys(null)).toEqual(['remote']);
  });
});

describe('mergeApplicant: profile', () => {
  it('saves the profile fields and the letter sentences; empty is null, an empty pitch is removed', () => {
    const a = mergeApplicant(
      { _help: 'h', coverLetter: { pitch: { default: 'old', laravel: 'kept' } } },
      form({
        fullName: ' Jane Doe ',
        email: 'jane@example.org',
        phone: '',
        countryCode: 'pt',
        utcOffset: 'GMT+0',
        'coverLetter.intro': 'I am Jane.',
        'coverLetter.pitch.default': '',
        'coverLetter.strengths': '',
        'coverLetter.remote': 'have worked remotely',
        'expectedSalary.PT': '40k EUR',
      }),
    );
    expect(a).toMatchObject({ fullName: 'Jane Doe', email: 'jane@example.org', phone: null, countryCode: 'PT', utcOffset: 'GMT+0' });
    expect(a.coverLetter).toEqual({ intro: 'I am Jane.', strengths: null, remote: 'have worked remotely', pitch: { laravel: 'kept' } });
    expect(a.expectedSalary).toEqual({ PT: '40k EUR' });
  });

  it('leaves profile fields alone when the form does not show them', () => {
    const a = mergeApplicant({ fullName: 'Jane', coverLetter: { intro: 'x' } }, form({}));
    expect(a.fullName).toBe('Jane');
    expect(a.coverLetter).toEqual({ intro: 'x' });
  });
});

describe('mergeApplicant', () => {
  const current = {
    _help: 'help',
    nationality: 'Pakistani',
    needsVisaSponsorship: true,
    extra: 'kept',
    expectedSalary: { AE: '20k AED', SA: null, NL: null, remote: null, PK: 'x' },
    other: { github: 'gh/me', removed: 'bye' },
  };

  it('turns empty fields into null and keeps unknown keys', () => {
    const a = mergeApplicant(
      current,
      form({
        nationality: '  ',
        currentLocation: 'Lahore',
        needsVisaSponsorship: 'true',
        'expectedSalary.AE': '',
        'expectedSalary.remote': ' 3k USD ',
        'other[0].key': 'github',
        'other[0].value': 'gh/me',
        'other[1].key': 'portfolio',
        'other[1].value': '',
        'other[2].key': '',
        'other[2].value': 'ignored',
      }),
    );
    expect(a).toMatchObject({
      _help: 'help',
      extra: 'kept',
      nationality: null,
      currentLocation: 'Lahore',
      noticePeriod: null,
      needsVisaSponsorship: true, // unchanged text keeps the original type
      expectedSalary: { AE: null, SA: null, NL: null, remote: '3k USD', PK: 'x' },
    });
    expect(a.other).toEqual({ github: 'gh/me', portfolio: null });
  });
});

describe('form helpers', () => {
  it('get reads dotted paths', () => {
    expect(get(CONFIG, 'ai.scoreModel')).toBe('haiku');
    expect(get(CONFIG, 'ai.nope.deeper')).toBeUndefined();
  });

  it('errorsFor matches a field and the items of its list, not other rows', () => {
    const errors = [
      { path: 'companies[3].ats', message: 'a' },
      { path: 'companies', message: 'b' },
      { path: 'linkedin.keywords[2]', message: 'c' },
      { path: 'minScore', message: 'd' },
    ];
    expect(errorsFor(errors, 'companies[3].ats').map((e) => e.message)).toEqual(['a']);
    expect(errorsFor(errors, 'companies').map((e) => e.message)).toEqual(['b']);
    expect(errorsFor(errors, 'linkedin.keywords').map((e) => e.message)).toEqual(['c']);
    expect(errorsFor(errors, 'minScore').map((e) => e.message)).toEqual(['d']);
  });
});
