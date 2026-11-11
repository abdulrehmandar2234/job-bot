import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { BOT_ROOT } from '@/lib/bot';
import { countryLabels, flag, market, marketLine, profileGaps } from '@/lib/market';
import { readCountryLabels, readMarketLine, readProfileStatus } from '@/lib/profile';

const json = (f: string) => JSON.parse(readFileSync(join(BOT_ROOT, f), 'utf8'));
const OWNER_CONFIG = json('config.default.json');
const OWNER_APPLICANT = json('tests/fixtures/applicant-owner.json');
const OWNER_MASTER = json('tests/fixtures/master-owner.json');

const dir = mkdtempSync(join(tmpdir(), 'talaash-market-'));
const tmp = (name: string, data: unknown) => {
  const f = join(dir, name);
  writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data));
  return f;
};
afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('labels and header from config.json', () => {
  it('flags from ISO codes', () => {
    expect(flag('AE')).toBe('🇦🇪');
    expect(flag('NL')).toBe('🇳🇱');
    expect(flag('RM')).toBe('🇷🇲'); // any two capitals is a flag; RM is only used for remote, which gets a globe
    expect(flag('x')).toBe('🌍');
  });

  it("the owner's config gives the same labels and header as before", () => {
    const m = market(OWNER_CONFIG, OWNER_APPLICANT);
    expect(countryLabels(m)).toEqual({
      AE: '🇦🇪 UAE',
      SA: '🇸🇦 Saudi',
      NL: '🇳🇱 Netherlands',
      PK: '🇵🇰 Pakistan',
      RM: '🌍 Remote (from Pakistan)',
    });
    expect(marketLine(m)).toBe(
      'UAE · Saudi Arabia · Netherlands with visa sponsorship · Pakistan onsite, plus remote roles open to Pakistan',
    );
  });

  it('a new user: her countries, visa needs and remote-from country', () => {
    const cfg = {
      countries: {
        NL: { name: 'Netherlands', visa: 'ind-register', match: 'nl', needsVisa: false },
        AE: { name: 'UAE', visa: 'employer', match: 'uae' },
      },
      remote: { enabled: true },
      linkedin: { remoteFrom: '' },
    };
    const m = market(cfg, { country: 'Portugal' });
    expect(countryLabels(m)).toEqual({ NL: '🇳🇱 Netherlands', AE: '🇦🇪 UAE', RM: '🌍 Remote (from Portugal)' });
    expect(marketLine(m)).toBe('UAE with visa sponsorship · Netherlands onsite, plus remote roles open to Portugal');
    expect(marketLine(market({ ...cfg, remote: { enabled: false } }, null))).toBe('UAE with visa sponsorship · Netherlands onsite');
    expect(countryLabels(market({ ...cfg, remote: { enabled: false } }, null))).not.toHaveProperty('RM');
    expect(marketLine(market({ countries: {}, remote: { enabled: true } }, null))).toBe('Remote roles');
    expect(marketLine(market(null, null))).toBe('No target countries yet: add them in Settings');
  });

  it('reads the files named by JOB_BOT_CONFIG / JOB_BOT_APPLICANT', () => {
    vi.stubEnv(
      'JOB_BOT_CONFIG',
      tmp('c.json', { countries: { DE: { name: 'Germany', match: 'de', visa: 'employer' } }, remote: { enabled: false } }),
    );
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    expect(readCountryLabels()).toEqual({ DE: '🇩🇪 Germany' });
    expect(readMarketLine()).toBe('Germany with visa sponsorship');
  });
});

describe('profile completeness', () => {
  it('fills name, email and location from the CV, and needs a country code and languages', () => {
    expect(profileGaps({}, {})).toEqual(['fullName', 'email', 'location', 'countryCode', 'languages']);
    expect(
      profileGaps({ countryCode: 'PT', languages: 'English' }, { name: 'Jane', contact: { email: 'j@x.io', location: 'Faro' } }),
    ).toEqual([]);
    expect(profileGaps({ country: 'Portugal', languages: ' and ' }, { name: 'Jane' })).toEqual(['email', 'countryCode', 'languages']);
  });

  it('the owner profile is complete; without countryCode it is not', () => {
    expect(profileGaps(OWNER_APPLICANT, OWNER_MASTER)).toEqual([]);
    expect(profileGaps({ ...OWNER_APPLICANT, countryCode: null }, OWNER_MASTER)).toEqual(['countryCode']);
  });

  it('readProfileStatus: a missing applicant.json is a first run, never the example', () => {
    vi.stubEnv('JOB_BOT_MASTER', tmp('master.json', { name: 'Jane Doe', contact: { email: 'j@x.io', location: 'Lisbon' } }));
    vi.stubEnv('JOB_BOT_APPLICANT', join(dir, 'missing.json'));
    expect(readProfileStatus()).toEqual({ exists: false, gaps: ['countryCode', 'languages'] });
    vi.stubEnv('JOB_BOT_APPLICANT', tmp('a.json', { countryCode: 'PT', languages: 'English' }));
    expect(readProfileStatus()).toEqual({ exists: true, gaps: [] });
    vi.stubEnv('JOB_BOT_APPLICANT', tmp('bad.json', '{ nope'));
    expect(readProfileStatus()).toEqual({ exists: true, gaps: ['countryCode', 'languages'] });
  });
});
