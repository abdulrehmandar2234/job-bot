import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Job } from '../src/db.ts';

// A new user, not the owner: Jane Doe from the example files (Lisbon, Portugal, speaks Dutch), looking at the
// Netherlands (EU, no visa needed), the UAE (visa needed) and remote jobs. Nothing of the owner may leak into what the
// bot writes for her. The files are set before the bot is imported, because config.json is loaded at import.

const ROOT = join(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'job-bot-jane-'));
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.default.json'), 'utf8'));
cfg.cvFileName = 'jane_doe_resume.pdf';
cfg.linkedin.remoteFrom = 'Portugal';
cfg.remote.from = 'Portugal';
cfg.remote.fromCode = 'PT';
cfg.remote.allow = 'worldwide|anywhere|global|portugal|europe|\\beu\\b|emea';
cfg.remote.deny = '\\b(us|usa)\\b|united states|canada|latam|india';
cfg.countries = {
  NL: { name: 'Netherlands', visa: 'ind-register', match: 'amsterdam|netherlands', needsVisa: false },
  AE: { name: 'UAE', visa: 'employer', match: 'dubai|\\buae\\b', needsVisa: true },
};
const app = JSON.parse(readFileSync(join(ROOT, 'cv', 'applicant.example.json'), 'utf8'));
app.languages = 'English, Portuguese, Dutch';
writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
writeFileSync(join(dir, 'applicant.json'), JSON.stringify(app));
Object.assign(process.env, {
  JOB_BOT_CONFIG: join(dir, 'config.json'),
  JOB_BOT_APPLICANT: join(dir, 'applicant.json'),
  JOB_BOT_MASTER: join(ROOT, 'cv', 'master.example.json'),
});

const { daysAgo, raw, mockFetch } = await import('./helpers.ts');
const { aiAnswers, aiCoverLetter, aiFollowUp, aiScore, aiSummary, applicantFacts, candidateSituation, cvText } = await import(
  '../src/ai.ts'
);
const { coverLetter } = await import('../src/cover.ts');
const { templateFollowUp } = await import('../src/followup.ts');
const { scoreJob, SKILLS } = await import('../src/match.ts');
const { loadProfile } = await import('../src/profile.ts');
const { BOARDS } = await import('../src/sources/boards.ts');

const OWNER = /Abdul|Rehman|Lahore|Pakistan|GMT\+5|abdulrehmandar|Qureos|Abyan|\bUrdu\b/;
const GENDERED = /\b(he|his|him|himself)\b/i;

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let log: string;
beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), 'jobbot-jane-ai-')), 'calls.jsonl');
  Object.assign(process.env, { JOB_BOT_CLAUDE: FAKE, FAKE_CLAUDE_LOG: log });
});
after(() => {
  delete process.env.JOB_BOT_CLAUDE;
});
const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
const system = (i = 0) => {
  const a = calls()[i].argv;
  return a[a.indexOf('--system-prompt') + 1];
};

const job = (o: Partial<Job> = {}) =>
  ({
    id: 'test:jane',
    source: 'greenhouse',
    company: 'Acme',
    title: 'Full Stack Engineer',
    location: 'Amsterdam',
    country: 'NL',
    url: 'https://x',
    description: 'React, Node.js and PostgreSQL',
    matched: ['React', 'Node.js'],
    cluster: 'default',
    follow_ups: 0,
    applied_at: new Date('2026-10-01T10:00:00Z'),
    ...o,
  }) as Job;

describe('a new user: profile', () => {
  it('comes from her applicant.json and CV', () => {
    const p = loadProfile();
    assert.equal(p.fullName, 'Jane Doe');
    assert.equal(p.location, 'Lisbon, Portugal');
    assert.equal(p.countryCode, 'PT');
    assert.deepEqual(p.languages, ['English', 'Portuguese', 'Dutch']);
    assert.match(cvText(), /^Jane Doe — Full Stack Engineer — Lisbon, Portugal/);
  });

  it('skills she has follow her CV', () => {
    const have = (n: string) => SKILLS.find((s) => s.name === n)?.have;
    assert.equal(have('React'), true);
    assert.equal(have('SQL'), true); // PostgreSQL
    assert.equal(have('Laravel'), false);
    assert.equal(have('PHP'), false);
  });
});

describe('a new user: template letters', () => {
  it('cover letter for a country she may already work in', () => {
    const l = coverLetter(job());
    assert.match(l, /^Dear Acme Hiring Team,\n\nI am applying for the Full Stack Engineer role\. I am a Full Stack Engineer with 5 years/);
    assert.match(l, /Most recently I built the booking platform/);
    assert.match(
      l,
      /I am based in Lisbon, Portugal, and ready to relocate to Netherlands\. I can already work in Netherlands without visa sponsorship\./,
    );
    assert.match(
      l,
      /Best regards,\nJane Doe\n\+351 900 000 000 \| jane\.doe@example\.com\nhttps:\/\/www\.linkedin\.com\/in\/jane-doe-example\/\n$/,
    );
    assert.doesNotMatch(l, OWNER);
  });

  it('cover letter for a visa country and for remote', () => {
    assert.match(coverLetter(job({ country: 'AE' })), /ready to relocate to UAE\. I would need employer visa sponsorship/);
    assert.match(
      coverLetter(job({ country: 'RM' })),
      /I am based in Lisbon, Portugal \(GMT\+0\), have worked remotely with distributed teams across Europe\./,
    );
  });

  it('follow-up is signed with her name', () => {
    assert.match(templateFollowUp(job(), null, loadProfile().fullName), /Best regards,\nJane Doe\n$/);
  });
});

describe('a new user: filters', () => {
  const score = (location: string, description = 'We use React, Node.js, TypeScript and PostgreSQL for REST APIs.') =>
    scoreJob(raw({ location, description, title: 'Senior Full Stack Engineer', posted_at: daysAgo(1) }));

  it('remote jobs are judged for her country', () => {
    assert.equal(score('Remote — Worldwide').visa, 'Remote: work from Portugal, no visa needed');
    assert.match(score('Remote — Kenya').filterReason!, /region does not include Portugal/);
    assert.ok(score('Remote — EMEA').flags.some((f) => /confirm Portugal is OK/.test(f)));
  });

  it('a country without a visa need skips the sponsorship rules', () => {
    const s = score('Amsterdam', 'React, Node.js, TypeScript, PostgreSQL, REST. EU work permit required.');
    assert.equal(s.filterReason, null);
    assert.equal(s.visa, 'Netherlands: no visa needed');
    assert.match(score('Dubai, UAE', 'React, Node.js, TypeScript. We do not offer visa sponsorship.').filterReason!, /no visa sponsorship/);
  });

  it('Dutch she speaks, German she does not', () => {
    assert.equal(score('Amsterdam', 'React, Node.js, TypeScript, PostgreSQL. Fluent Dutch required.').filterReason, null);
    assert.match(score('Amsterdam', 'React, Node.js, TypeScript. Fluent German required.').filterReason!, /language required/);
  });
});

describe('a new user: AI prompts', () => {
  it('screening describes her, not the owner', async () => {
    assert.equal(
      candidateSituation(),
      'The candidate lives in Lisbon, Portugal, speaks English, Portuguese and Dutch only, and needs employer visa sponsorship for onsite roles (UAE) and may already work in Netherlands without sponsorship; remote roles must be open to someone working from Portugal.',
    );
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ score: 1, verdict: 'poor', summary: '', reasons: [], gaps: [], red_flags: [] });
    await aiScore(job({ country: 'RM' }));
    const s = system();
    assert.match(s, /language other than English\/Portuguese\/Dutch required/);
    assert.match(calls()[0].stdin, /LOCATION: Amsterdam \(remote; candidate would work from Portugal\)/);
    assert.doesNotMatch(s + calls()[0].stdin, OWNER);
    assert.doesNotMatch(s, GENDERED);
  });

  it('cover letter prompt: her signature and situation, no he/his', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ letter: 'x' });
    await aiCoverLetter(job());
    await aiCoverLetter(job({ country: 'RM' }));
    const [onsite, remote] = [system(0), system(1)];
    assert.match(
      onsite,
      /Best regards,\nJane Doe\n\+351 900 000 000 \| jane\.doe@example\.com\nhttps:\/\/www\.linkedin\.com\/in\/jane-doe-example\//,
    );
    assert.match(
      onsite,
      /say the candidate is based in Lisbon, Portugal, ready to relocate and can already work there without sponsorship/,
    );
    assert.match(remote, /say the candidate is based in Lisbon, Portugal \(GMT\+0\)/);
    for (const s of [onsite, remote]) {
      assert.doesNotMatch(s, OWNER);
      assert.doesNotMatch(s, GENDERED);
    }
  });

  it('CV summary prompt, with and without feedback: her CV only, no he/his', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ summary: 'x', note: '' });
    await aiSummary(job());
    await aiSummary(job({ cv_summary: 'x' }), 'shorter');
    for (const [i, c] of calls().entries()) {
      assert.doesNotMatch(system(i) + c.stdin, OWNER);
      assert.doesNotMatch(system(i), GENDERED);
    }
  });

  it('form answers and follow-ups', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ answers: [] });
    await aiAnswers(job({ country: 'AE' }), 'Do you need sponsorship?');
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ message: 'x' });
    await aiFollowUp(job(), null);
    const [answers, followUp] = [system(0), system(1)];
    assert.match(answers, /Onsite role: the candidate is in Lisbon, Portugal, would relocate and needs employer visa sponsorship/);
    assert.match(followUp, /Best regards,\nJane Doe"/);
    assert.match(followUp, /This is their first follow-up/);
    for (const s of [answers, followUp]) {
      assert.doesNotMatch(s, OWNER);
      assert.doesNotMatch(s, GENDERED);
    }
    const facts = JSON.parse(applicantFacts());
    assert.equal(facts.fullName, 'Jane Doe');
    assert.equal(facts.coverLetter, undefined); // letter sentences are not form facts
  });
});

describe('a new user: remote boards', () => {
  it('Himalayas searches remote jobs open to her country', async () => {
    const m = mockFetch({ 'himalayas.app': { jobs: [] } });
    try {
      await BOARDS.himalayas();
    } finally {
      m.restore();
    }
    const urls = m.calls.filter((u) => u.includes('himalayas'));
    assert.ok(urls.length > 0);
    assert.ok(urls.every((u) => u.includes('country=PT&')));
  });
});
