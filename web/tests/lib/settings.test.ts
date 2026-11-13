import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_ROOT } from '@/lib/bot';
import { aiKeyStatus, applicantFile, configFile, defaultConfigFile, ensureConfigFile, readApplicant, readConfig } from '@/lib/settings';
import {
  AI_KEY_ENV,
  API_PRESETS,
  detectPreset,
  errorsFor,
  get,
  mergeApplicant,
  mergeConfig,
  PRESETS,
  salaryKeys,
} from '@/lib/settings-form';

const dir = mkdtempSync(join(tmpdir(), 'talaash-web-settings-'));
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

  it('config.json starts as a copy of config.default.json, only at its own place and only when missing', () => {
    expect(defaultConfigFile()).toBe(join(BOT_ROOT, 'config.default.json'));
    const home = join(dir, 'home-config.json');
    const defaults = tmp('defaults.json', '{"minScore": 1}');
    expect(ensureConfigFile(home, defaults, home)).toBe(true);
    expect(readFileSync(home, 'utf8')).toBe('{"minScore": 1}');
    writeFileSync(home, '{"minScore": 9}');
    expect(ensureConfigFile(home, defaults, home)).toBe(false);
    expect(readFileSync(home, 'utf8')).toBe('{"minScore": 9}');
    const other = join(dir, 'typo.json');
    expect(ensureConfigFile(other, defaults, home)).toBe(false); // a missing JOB_BOT_CONFIG file stays missing
    expect(existsSync(other)).toBe(false);
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

  it("detects the provider from a key prefix (the bot's presets, so the Settings page names the same provider)", () => {
    expect(['sk-ant-x', 'gsk_x', 'sk-or-x', 'AIzax', 'sk-x', 'x', ''].map(detectPreset)).toEqual([
      'anthropic',
      'groq',
      'openrouter',
      'gemini',
      'openai',
      null,
      null,
    ]);
    expect(Object.keys(PRESETS)).toEqual([...API_PRESETS]);
    expect(AI_KEY_ENV).toBe('AI_API_KEY');
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

  it('saves skipJobTypes one per line, and an empty field as "keep every type"', () => {
    expect(mergeConfig(CONFIG, configForm({ skipJobTypes: 'internship\npart-time\n' })).skipJobTypes).toEqual(['internship', 'part-time']);
    expect(mergeConfig(CONFIG, configForm({ skipJobTypes: '' })).skipJobTypes).toEqual([]);
  });

  it('saves cvTemplate, and leaves the key out for classic (the built-in default)', () => {
    expect(mergeConfig(CONFIG, configForm({ cvTemplate: 'compact' })).cvTemplate).toBe('compact');
    expect('cvTemplate' in mergeConfig({ ...CONFIG, cvTemplate: 'modern' }, configForm({ cvTemplate: '' }))).toBe(false);
    expect(mergeConfig({ ...CONFIG, cvTemplate: 'modern' }, configForm()).cvTemplate).toBe('modern'); // not in the form: kept
  });

  it('saves blockedCompanies one per line, and an empty box as an empty list', () => {
    expect(mergeConfig(CONFIG, configForm({ blockedCompanies: ' Acme Inc. \n\nGlobex\n' })).blockedCompanies).toEqual([
      'Acme Inc.',
      'Globex',
    ]);
    expect(mergeConfig({ ...CONFIG, blockedCompanies: ['Acme'] }, configForm({ blockedCompanies: '' })).blockedCompanies).toEqual([]);
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

  it('cleared remote region patterns are removed, so the bot computes them from the country', () => {
    const cfg = mergeConfig(CONFIG, configForm({ 'remote.allow': ' ', 'remote.deny': '', 'remote.flag': '' })) as {
      remote: Record<string, unknown>;
    };
    expect(['allow' in cfg.remote, 'deny' in cfg.remote, 'flag' in cfg.remote]).toEqual([false, false, false]);
    expect(cfg.remote.boards).toEqual(['himalayas', 'remotive']);
    expect(mergeConfig(CONFIG, configForm({ 'remote.allow': 'worldwide|india' }))).toMatchObject({ remote: { allow: 'worldwide|india' } });
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

  it('saves "api", and a switch back when the file named one', () => {
    const api = mergeConfig(CONFIG, configForm({ 'ai.provider': 'api' }));
    expect(get(api, 'ai.provider')).toBe('api');
    expect(get(mergeConfig(api, configForm({ 'ai.provider': 'claude-cli' })), 'ai.provider')).toBe('claude-cli');
    expect(get(mergeConfig(api, configForm()), 'ai.provider')).toBe('api'); // no select in the form: kept
  });

  it('saves the preset, base URL and models; cleared fields are removed without leaving an empty section', () => {
    const cfg = mergeConfig(
      CONFIG,
      configForm({ 'ai.provider': 'api', 'ai.api.preset': 'anthropic', 'ai.api.scoreModel': ' claude-x ', 'ai.api.baseUrl': '' }),
    );
    expect(get(cfg, 'ai.api')).toEqual({ preset: 'anthropic', scoreModel: 'claude-x' });
    const cleared = mergeConfig(
      cfg,
      configForm({ 'ai.api.preset': '', 'ai.api.scoreModel': '', 'ai.api.letterModel': '', 'ai.api.baseUrl': '' }),
    );
    expect('api' in (cleared.ai as object)).toBe(false); // auto-detect with the preset defaults
    expect(cleared.ai).toMatchObject({ claudePath: '/bin/claude', concurrency: 2 });
  });

  it('keeps api keys the form does not show (responseFormat)', () => {
    const current = { ...CONFIG, ai: { ...(CONFIG.ai as object), api: { scoreModel: 'x', responseFormat: 'text' } } };
    expect(get(mergeConfig(current, configForm({ 'ai.api.scoreModel': '' })), 'ai.api')).toEqual({ responseFormat: 'text' });
  });

  it('saving an older "openai" / "deepseek" config as "api" drops the older section (its models were shown in ai.api)', () => {
    const current = { ...CONFIG, ai: { ...(CONFIG.ai as object), provider: 'deepseek', deepseek: { letterModel: 'deepseek-reasoner' } } };
    const cfg = mergeConfig(
      current,
      configForm({ 'ai.provider': 'api', 'ai.api.preset': 'deepseek', 'ai.api.letterModel': 'deepseek-reasoner' }),
    );
    expect(cfg.ai).toMatchObject({ provider: 'api', api: { preset: 'deepseek', letterModel: 'deepseek-reasoner' } });
    expect('deepseek' in (cfg.ai as object)).toBe(false);
  });
});

describe('aiKeyStatus', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const keys = (envFile: string, env: Record<string, string> = {}) => {
    vi.stubEnv('JOB_BOT_ENV_FILE', tmp('env-file', envFile));
    for (const k of ['AI_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY']) vi.stubEnv(k, env[k] ?? '');
    return aiKeyStatus();
  };

  it("reads AI_API_KEY from the bot's env file and says whose key it looks like", () => {
    expect(keys('ADZUNA_APP_ID=1\nAI_API_KEY=sk-ant-secret\n')).toEqual({ keyEnv: 'AI_API_KEY', provider: 'anthropic' });
    expect(keys('AI_API_KEY="gsk_secret" # groq\n')).toEqual({ keyEnv: 'AI_API_KEY', provider: 'groq' });
    expect(keys('export AI_API_KEY=AIzaSecret\n')).toEqual({ keyEnv: 'AI_API_KEY', provider: 'gemini' });
    expect(keys('AI_API_KEY=unknown-secret\n')).toEqual({ keyEnv: 'AI_API_KEY', provider: null });
  });

  it('ignores empty values and comments, and falls back to the older key names', () => {
    expect(keys('# AI_API_KEY=sk-secret\nAI_API_KEY=""\n')).toEqual({ keyEnv: null, provider: null });
    expect(keys('DEEPSEEK_API_KEY=sk-secret\n')).toEqual({ keyEnv: 'DEEPSEEK_API_KEY', provider: 'deepseek' });
    expect(keys('OPENAI_API_KEY=sk-secret\nAI_API_KEY=sk-or-secret\n')).toEqual({ keyEnv: 'AI_API_KEY', provider: 'openrouter' });
  });

  it('also reads the environment the bot inherits (it wins), and a missing env file', () => {
    expect(keys('AI_API_KEY=sk-ant-secret\n', { AI_API_KEY: 'sk-proj-secret' })).toEqual({ keyEnv: 'AI_API_KEY', provider: 'openai' });
    vi.stubEnv('JOB_BOT_ENV_FILE', join(dir, 'no-such-env'));
    vi.stubEnv('AI_API_KEY', '');
    expect(aiKeyStatus()).toEqual({ keyEnv: null, provider: null });
  });

  it('never returns the value', () => {
    expect(JSON.stringify(keys('AI_API_KEY=sk-ant-very-secret\n'))).not.toContain('secret');
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

  it('saves the birth date from the date field, an empty one as null, and keeps an older birthYear', () => {
    const a = mergeApplicant({ birthYear: 1996 }, form({ birthDate: '1996-06-15' }));
    expect(a.birthDate).toBe('1996-06-15');
    expect(a.birthYear).toBe(1996);
    expect(mergeApplicant({ birthDate: '1996-06-15' }, form({ birthDate: '' })).birthDate).toBeNull();
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
