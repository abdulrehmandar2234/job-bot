import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysAgo, raw } from './helpers.ts';
import { candidateSituation } from '../src/ai.ts';
import { config } from '../src/config.ts';
import { coverLetter } from '../src/cover.ts';
import { templateFollowUp } from '../src/followup.ts';
import { languageRules, scoreJob, SKILLS, withCv } from '../src/match.ts';
import {
  blankApplicant,
  buildProfile,
  listText,
  loadProfile,
  needsVisa,
  profileGaps,
  readApplicant,
  remoteFrom,
  remoteFromCode,
  signature,
  splitLanguages,
  whereText,
  yesNo,
} from '../src/profile.ts';
import { validateApplicant, validateConfig } from '../src/settings.ts';
import type { Job } from '../src/db.ts';

// The owner's profile is tests/fixtures/applicant-owner.json (set in helpers.ts), with the real config.json and
// cv/master.json. owner-golden.json holds what the code produced before the profile existed, when every personal
// value was hardcoded: the owner must get exactly the same letters, follow-ups and filter results.

const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'owner-golden.json'), 'utf8'));
const MASTER = {
  name: 'Jane Doe',
  title: 'Engineer',
  contact: { phone: '+1', email: 'j@x.io', location: 'Lisbon, Portugal', linkedin: 'https://l/x' },
};

describe('profile: building it', () => {
  it('reads every field and falls back to the CV for name, contact and location', () => {
    const p = buildProfile(
      {
        city: 'Porto',
        country: 'Portugal',
        countryCode: 'pt',
        utcOffset: 'GMT+0',
        languages: 'English and Portuguese',
        willingToRelocate: 'Yes',
      },
      MASTER,
    );
    assert.deepEqual(
      { ...p, letter: undefined },
      {
        fullName: 'Jane Doe',
        email: 'j@x.io',
        phone: '+1',
        linkedin: 'https://l/x',
        location: 'Porto, Portugal',
        countryCode: 'PT',
        country: 'Portugal',
        utcOffset: 'GMT+0',
        languages: ['English', 'Portuguese'],
        relocate: true,
        letter: undefined,
      },
    );
    const own = buildProfile({ fullName: 'J. Doe', email: 'me@y.io', phone: '', currentLocation: 'Faro' }, MASTER);
    assert.equal(own.fullName, 'J. Doe');
    assert.equal(own.email, 'me@y.io');
    assert.equal(own.phone, '+1'); // empty = not set
    assert.equal(own.location, 'Faro');
    assert.equal(buildProfile({}, MASTER).location, 'Lisbon, Portugal');
    assert.equal(buildProfile({}, {}).fullName, null);
  });

  it('splits languages and reads yes/no answers', () => {
    assert.deepEqual(splitLanguages('English, Urdu'), ['English', 'Urdu']);
    assert.deepEqual(splitLanguages('English (fluent) / Dutch & German'), ['English', 'Dutch', 'German']);
    assert.deepEqual(splitLanguages(null), []);
    assert.equal(yesNo('Yes, to UAE, Saudi Arabia or the Netherlands'), true);
    assert.equal(yesNo(true), true);
    assert.equal(yesNo('No'), false);
    assert.equal(yesNo('Yearly contract'), null);
    assert.equal(yesNo(null), null);
  });

  it('lists the required fields still missing', () => {
    assert.deepEqual(profileGaps(buildProfile({}, {})), ['fullName', 'email', 'location', 'countryCode', 'languages']);
    assert.deepEqual(profileGaps(buildProfile({ countryCode: 'PT', languages: 'English' }, MASTER)), []);
  });

  it('the owner profile is complete', () => {
    assert.deepEqual(profileGaps(loadProfile()), []);
    assert.equal(loadProfile().fullName, 'Abdul Rehman Dar');
  });

  it('signature, location and list helpers leave unknown parts out', () => {
    assert.equal(signature({ fullName: 'Jane', phone: null, email: 'j@x.io', linkedin: null }), 'Best regards,\nJane\nj@x.io');
    assert.equal(whereText({ location: 'Lisbon', utcOffset: 'GMT+0' }), 'Lisbon (GMT+0)');
    assert.equal(whereText({ location: null, utcOffset: 'GMT+0' }), null);
    assert.equal(listText(['a', 'b', 'c']), 'a, b and c');
    assert.equal(listText(['a']), 'a');
  });

  it('remote-from and visa come from config, then the profile', () => {
    const p = buildProfile({ country: 'Portugal', countryCode: 'PT' });
    const cfg = { remote: { ...config.remote, from: undefined, fromCode: undefined }, linkedin: { ...config.linkedin, remoteFrom: '' } };
    assert.equal(remoteFrom(cfg, p), 'Portugal');
    assert.equal(remoteFromCode(cfg, p), 'PT');
    assert.equal(remoteFrom({ ...cfg, linkedin: { ...cfg.linkedin, remoteFrom: 'Spain' } }, p), 'Spain');
    assert.equal(remoteFrom({ ...cfg, remote: { ...cfg.remote, from: 'Brazil' } }, p), 'Brazil');
    const countries = {
      NL: { name: 'Netherlands', visa: 'ind-register' as const, match: 'nl', needsVisa: false },
      AE: { name: 'UAE', visa: 'employer' as const, match: 'uae' },
    };
    assert.equal(needsVisa({ countries }, 'NL'), false);
    assert.equal(needsVisa({ countries }, 'AE'), true); // missing = needs one
    assert.equal(needsVisa({ countries }, 'AE', { countryCode: 'AE' }), false); // lives there
  });
});

describe('profile: the files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-bot-profile-'));

  it('a missing applicant.json is all unknown, never the example person', () => {
    const blank = blankApplicant() as Record<string, unknown>;
    assert.equal(blank.fullName, null);
    assert.equal(blank.city, null);
    assert.deepEqual(blank.other, {});
    assert.ok(!JSON.stringify(blank).includes('Jane'));
    assert.equal(validateApplicant(blank).ok, true);
    const before = process.env.JOB_BOT_APPLICANT;
    process.env.JOB_BOT_APPLICANT = join(dir, 'missing.json');
    try {
      assert.equal(readApplicant().fullName, null);
      assert.equal(loadProfile().fullName, 'Abdul Rehman Dar'); // from cv/master.json
      assert.equal(loadProfile().utcOffset, null);
    } finally {
      process.env.JOB_BOT_APPLICANT = before;
    }
  });

  it('the example files are valid and hold no personal data of the owner', () => {
    for (const f of ['cv/applicant.example.json', 'cv/master.example.json']) {
      const text = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
      assert.doesNotMatch(text, /Abdul|Rehman|Lahore|Pakistan|4979646|abdulrehmandar/i, f);
    }
    assert.equal(
      validateApplicant(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'cv', 'applicant.example.json'), 'utf8'))).ok,
      true,
    );
  });

  it('validates the new profile fields', () => {
    const bad = validateApplicant({
      email: 'nope',
      countryCode: 'Pakistan',
      utcOffset: '+5',
      linkedin: 'x',
      coverLetter: { pitch: { a: 1 } },
    });
    assert.equal(bad.ok, false);
    const paths = bad.ok ? [] : bad.errors.map((e) => e.path).sort();
    assert.deepEqual(paths, ['countryCode', 'coverLetter.pitch.a', 'email', 'linkedin', 'utcOffset']);
    assert.equal(validateApplicant({ email: '', linkedin: '', countryCode: null, utcOffset: 'UTC-3:30' }).ok, true);
  });

  it('validates the new market fields in config.json', () => {
    const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config.json'), 'utf8'));
    assert.equal(validateConfig(cfg).ok, true);
    cfg.remote.fromCode = 'pk';
    cfg.countries.AE.needsVisa = 'yes';
    const res = validateConfig(cfg);
    assert.deepEqual(res.ok ? [] : res.errors.map((e) => e.path).sort(), ['countries.AE.needsVisa', 'remote.fromCode']);
    // Older files without them still load.
    delete cfg.remote.fromCode;
    delete cfg.remote.from;
    delete cfg.countries.AE.needsVisa;
    assert.equal(validateConfig(cfg).ok, true);
  });
});

describe('skills on the CV', () => {
  it('have follows the skills listed in cv/master.json', () => {
    const skills = withCv(
      [
        { name: 'React', re: /\breact\b/i },
        { name: 'SQL', re: /\bsql\b/i, cv: /mysql|postgres/i },
        { name: 'Go', re: /\bgolang\b/i },
      ],
      'React.js\nPostgreSQL',
    );
    assert.deepEqual(
      skills.map((s) => [s.name, s.have]),
      [
        ['React', true],
        ['SQL', true],
        ['Go', false],
      ],
    );
  });

  it('the owner CV gives the same have list as the old hardcoded one', () => {
    const lacks = [
      'Microservices',
      'Angular',
      'Kubernetes',
      'Redis',
      'Kafka',
      'Terraform',
      'GCP',
      'Azure',
      'Python',
      'Go',
      'Java',
      'Ruby',
      'C#/.NET',
    ];
    assert.deepEqual(
      SKILLS.filter((s) => !s.have).map((s) => s.name),
      lacks,
    );
    assert.equal(SKILLS.length, 43);
  });

  it('a language the candidate speaks is never a blocker', () => {
    const nl = languageRules(['English', 'Dutch']);
    assert.equal(nl.required.test('Fluent Dutch required'), false);
    assert.equal(nl.required.test('Fluent German required'), true);
    assert.equal(nl.bonus.test('Dutch is a plus'), false);
    assert.equal(nl.bonus.test('Arabic is a plus'), true);
    const all = languageRules(['dutch', 'arabic', 'german', 'french']);
    assert.equal(all.required.test('Fluent Dutch required. French is mandatory.'), false);
    assert.equal(all.bonus.test('Arabic is a plus'), false);
  });
});

describe('owner regression: same output as before the profile', () => {
  const base = {
    company: 'Acme',
    title: 'Senior Laravel Developer',
    matched: ['Laravel', 'PHP', 'React'],
    cluster: 'laravel',
    country: 'AE',
  };

  it('template cover letters', () => {
    for (const [key, want] of Object.entries(golden.covers as Record<string, string>)) {
      if (key === 'cover:nomatch') {
        assert.equal(coverLetter({ ...base, matched: [] } as unknown as Job), want, key);
        continue;
      }
      const [, c, cl] = key.split(':');
      const job = { ...base, country: c === 'null' ? null : c, cluster: cl === 'null' ? null : cl } as unknown as Job;
      assert.equal(coverLetter(job), want, key);
    }
  });

  it('template follow-ups', () => {
    const job = { company: 'Acme', title: 'Dev', applied_at: new Date('2026-10-01T10:00:00Z'), follow_ups: 0 };
    assert.equal(templateFollowUp(job, null), golden.followUps.fu0);
    assert.equal(templateFollowUp({ ...job, applied_at: null, follow_ups: 1 }, 'Jane'), golden.followUps.fu1);
  });

  it('filters, visa notes and flags', () => {
    const descs = [
      'We use Laravel, PHP, React, Node.js, TypeScript and PostgreSQL to build REST APIs.',
      'Laravel PHP React Node TypeScript. Fluent Dutch required.',
      'Laravel PHP React Node TypeScript. Arabic is a plus.',
      'Laravel PHP React Node TypeScript. We do not offer visa sponsorship.',
      'Laravel PHP React Node TypeScript SQL Redis Kafka. Visa sponsorship available.',
      'Fluent German required. Laravel PHP React Node',
      'French is mandatory. Laravel PHP React Node',
    ];
    for (const [key, want] of Object.entries(golden.scores as Record<string, object>)) {
      const [location, i] = key.split('|');
      const s = scoreJob(
        raw({ company: 'Acme', title: 'Senior Full Stack Engineer', location, description: descs[Number(i)], posted_at: daysAgo(2) }),
      );
      const { country, score, cluster, visa, flags, filterReason, matched, missing } = s;
      assert.deepEqual({ country, score, cluster, visa, flags, filterReason, matched, missing }, want, key);
    }
  });

  it('the screening prompt describes the owner as before', () => {
    assert.equal(
      candidateSituation(),
      'The candidate lives in Lahore, Pakistan, speaks English and Urdu only, and needs employer visa sponsorship for onsite roles (UAE, Saudi Arabia, Netherlands); remote roles must be open to someone working from Pakistan.',
    );
  });
});
