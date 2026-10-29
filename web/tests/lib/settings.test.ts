import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { ATS as BOT_ATS } from '../../../src/settings';
import { BOT_ROOT } from '@/lib/bot';
import { applicantFile, configFile, readApplicant, readConfig } from '@/lib/settings';
import { ATS, errorsFor, get, mergeApplicant, mergeConfig } from '@/lib/settings-form';

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

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

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

  it('has the same ATS list as the bot', () => {
    expect([...ATS]).toEqual([...BOT_ATS]);
  });
});

const CONFIG = {
  cvFileName: 'cv.pdf', minScore: 45, maxAgeDays: 14, autoCvVersions: true, roleInclude: 'dev', roleExclude: 'senior',
  futureKey: { keep: 1 },
  ai: { enabled: true, claudePath: '/bin/claude', scoreModel: 'haiku', letterModel: 'sonnet', maxScorePerRun: 80, concurrency: 2 },
  linkedin: { enabled: true, keywords: ['php'], locations: ['Dubai'], remoteFrom: 'Pakistan', pagesPerSearch: 2 },
  remote: { enabled: true, boards: ['himalayas'], himalayasQueries: ['php'], allow: 'a', deny: 'd', flag: 'f' },
  countries: { AE: { name: 'UAE', visa: 'employer', match: 'dubai' } },
  companies: [{ name: 'Elastic', ats: 'greenhouse', token: 'elastic', indName: 'elasticsearch B.V.' }, { name: 'Old', ats: 'lever', token: 'old' }],
};

const configForm = (over: Record<string, string> = {}) => form({
  minScore: '50', maxAgeDays: '10', roleInclude: ' dev|eng ', roleExclude: 'senior',
  'linkedin.enabled': 'on', 'linkedin.keywords': 'php\n  laravel \n\n', 'linkedin.locations': 'Dubai', 'linkedin.remoteFrom': 'Pakistan',
  'linkedin.pagesPerSearch': '3', 'remote.boards': 'himalayas\nremotive', 'remote.himalayasQueries': 'php',
  'remote.allow': 'a', 'remote.deny': 'd', 'remote.flag': 'f', 'ai.enabled': 'on', 'ai.scoreModel': 'haiku',
  'ai.letterModel': 'opus', 'ai.maxScorePerRun': '40', 'countries.AE.match': 'dubai|abu dhabi',
  'companies[0].orig': '0', 'companies[0].name': 'Elastic NV', 'companies[0].ats': 'greenhouse', 'companies[0].token': 'elastic',
  'companies[1].orig': '-1', 'companies[1].name': 'New Co', 'companies[1].ats': 'ashby', 'companies[1].token': 'newco',
  ...over,
});

describe('mergeConfig', () => {
  it('applies the form, keeping keys the form does not show', () => {
    const cfg = mergeConfig(CONFIG, configForm());
    expect(cfg).toMatchObject({
      cvFileName: 'cv.pdf', futureKey: { keep: 1 }, minScore: 50, maxAgeDays: 10, roleInclude: 'dev|eng',
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

  it('ignores country fields for countries that are not in the file', () => {
    const cfg = mergeConfig(CONFIG, configForm({ 'countries.XX.match': 'x', 'countries.__proto__.match': 'x' }));
    expect(Object.keys(cfg.countries as object)).toEqual(['AE']);
  });
});

describe('mergeApplicant', () => {
  const current = {
    _help: 'help', nationality: 'Pakistani', needsVisaSponsorship: true, extra: 'kept',
    expectedSalary: { AE: '20k AED', SA: null, NL: null, remote: null, PK: 'x' },
    other: { github: 'gh/me', removed: 'bye' },
  };

  it('turns empty fields into null and keeps unknown keys', () => {
    const a = mergeApplicant(current, form({
      nationality: '  ', currentLocation: 'Lahore', needsVisaSponsorship: 'true',
      'expectedSalary.AE': '', 'expectedSalary.remote': ' 3k USD ',
      'other[0].key': 'github', 'other[0].value': 'gh/me', 'other[1].key': 'portfolio', 'other[1].value': '',
      'other[2].key': '', 'other[2].value': 'ignored',
    }));
    expect(a).toMatchObject({
      _help: 'help', extra: 'kept', nationality: null, currentLocation: 'Lahore', noticePeriod: null,
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
      { path: 'companies[3].ats', message: 'a' }, { path: 'companies', message: 'b' },
      { path: 'linkedin.keywords[2]', message: 'c' }, { path: 'minScore', message: 'd' },
    ];
    expect(errorsFor(errors, 'companies[3].ats').map((e) => e.message)).toEqual(['a']);
    expect(errorsFor(errors, 'companies').map((e) => e.message)).toEqual(['b']);
    expect(errorsFor(errors, 'linkedin.keywords').map((e) => e.message)).toEqual(['c']);
    expect(errorsFor(errors, 'minScore').map((e) => e.message)).toEqual(['d']);
  });
});
