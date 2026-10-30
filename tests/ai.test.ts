import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.ts';
import { aiAnswers, aiCoverLetter, aiScore, aiSummary, applicantFacts, cvText } from '../src/ai.ts';
import { askClaude } from '../src/ai-providers.ts';
import type { Job } from '../src/db.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let log: string;

beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), 'jobbot-ai-')), 'calls.jsonl');
  Object.assign(process.env, { JOB_BOT_CLAUDE: FAKE, FAKE_CLAUDE_LOG: log });
  delete process.env.FAKE_CLAUDE_FAIL;
});
afterEach(() => {
  delete process.env.JOB_BOT_CLAUDE;
  delete process.env.FAKE_CLAUDE_OUT;
});

const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
const arg = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];

const job = (o: Partial<Job> = {}) =>
  ({
    id: 'test:ai',
    source: 'linkedin',
    company: 'Acme',
    title: 'Senior Laravel Developer',
    location: 'Dubai',
    country: 'AE',
    url: 'https://x',
    description: 'Laravel and Vue.js',
    matched: ['Laravel'],
    cluster: 'laravel',
    form_answers: [],
    ...o,
  }) as Job;

describe('askClaude', () => {
  it('runs the CLI headless with no tools and returns structured_output', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ ok: 1 });
    assert.deepEqual(await askClaude('hello', { type: 'object' }, 'haiku', 'be brief'), { ok: 1 });
    const [{ argv, stdin }] = calls();
    assert.equal(stdin, 'hello');
    assert.equal(arg(argv, '--model'), 'haiku');
    assert.equal(arg(argv, '--tools'), '');
    assert.ok(argv.includes('--no-session-persistence') && argv.includes('--strict-mcp-config'));
    assert.equal(arg(argv, '--system-prompt'), 'be brief');
  });

  it('rejects when the CLI reports an error', async () => {
    process.env.FAKE_CLAUDE_FAIL = 'usage limit reached';
    await assert.rejects(askClaude('x', {}, 'haiku', ''), /usage limit reached/);
  });

  it('rejects when the CLI cannot be started', async () => {
    process.env.JOB_BOT_CLAUDE = '/nonexistent/claude';
    await assert.rejects(askClaude('x', {}, 'haiku', ''), /ENOENT/);
  });
});

describe('prompts', () => {
  it('cvText contains the CV facts', () => {
    const t = cvText();
    assert.match(t, /Abdul Rehman Dar/);
    assert.match(t, /EXPERIENCE: Senior Software Engineer, Qureos/);
    assert.match(t, /SKILLS: .*Laravel/);
  });

  it('applicantFacts never sends the help text and keeps unknowns null', () => {
    const facts = JSON.parse(applicantFacts());
    assert.equal(facts._help, undefined);
    assert.equal(facts.languages, 'English, Urdu');
    assert.ok('noticePeriod' in facts);
  });

  it('aiScore sends the CV and the job with the scoring model', async () => {
    const out = { score: 80, verdict: 'good', summary: 's', reasons: [], gaps: [], red_flags: [] };
    process.env.FAKE_CLAUDE_OUT = JSON.stringify(out);
    assert.deepEqual(await aiScore(job()), out);
    const [{ argv, stdin }] = calls();
    assert.equal(arg(argv, '--model'), 'haiku');
    assert.match(stdin, /CANDIDATE CV:[\s\S]*TITLE: Senior Laravel Developer/);
    assert.match(arg(argv, '--system-prompt'), /English and Urdu only/);
  });

  it('aiCoverLetter tells the model about relocation for onsite and Pakistan for remote', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ letter: '  Dear Acme Hiring Team,\nHi  ' });
    assert.deepEqual(await aiCoverLetter(job()), { letter: 'Dear Acme Hiring Team,\nHi\n', note: '' });
    await aiCoverLetter(job({ country: 'RM' }));
    const [onsite, remote] = calls().map((c) => arg(c.argv, '--system-prompt'));
    assert.match(onsite, /ready to relocate[\s\S]*visa sponsorship/);
    assert.match(onsite, /Never make commitments/);
    assert.match(remote, /remote role[\s\S]*GMT\+5/);
    assert.match(onsite, /Dear Acme Hiring Team,/);
  });

  it('aiCoverLetter without feedback asks for the letter only, with no revision rules', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ letter: 'Dear Acme Hiring Team,' });
    await aiCoverLetter(job({ cover_letter: 'Old letter' }));
    const [{ argv, stdin }] = calls();
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['letter']);
    assert.doesNotMatch(arg(argv, '--system-prompt'), /REVISION/);
    assert.doesNotMatch(stdin, /CURRENT LETTER|FEEDBACK/);
  });

  it('aiCoverLetter with feedback sends the current letter and the feedback, keeps the rules and returns the note', async () => {
    const note = 'The CV does not show Kubernetes, so the letter does not claim it.';
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ letter: ' Dear Acme Hiring Team,\nShorter ', note: ` ${note} ` });
    const res = await aiCoverLetter(
      job({ cover_letter: 'Dear Acme Hiring Team,\nThe old long letter.\n' }),
      '  shorter, and mention Kubernetes ',
    );
    assert.deepEqual(res, { letter: 'Dear Acme Hiring Team,\nShorter\n', note });
    const [{ argv, stdin }] = calls();
    assert.equal(arg(argv, '--model'), 'sonnet');
    const system = arg(argv, '--system-prompt');
    assert.match(system, /Use ONLY facts in the CV/);
    assert.match(system, /Never make commitments/);
    assert.match(system, /REVISION: the candidate gives you the CURRENT LETTER and FEEDBACK/);
    assert.match(system, /do not add it, and say so in "note"/);
    assert.doesNotMatch(system, /mention Kubernetes/, 'the feedback is user text: it goes in the user prompt, not the rules');
    assert.match(
      stdin,
      /CV:[\s\S]*JOB:[\s\S]*CURRENT LETTER:\nDear Acme Hiring Team,\nThe old long letter\.\n\nFEEDBACK FROM THE CANDIDATE:\nshorter, and mention Kubernetes$/,
    );
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['letter', 'note']);
  });

  it('aiSummary writes a summary for the job with the letter model and the truthfulness rules', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ summary: '  Senior engineer with\n7+ years of Laravel.  ' });
    assert.deepEqual(await aiSummary(job()), { summary: 'Senior engineer with 7+ years of Laravel.', note: '' });
    const [{ argv, stdin }] = calls();
    assert.equal(arg(argv, '--model'), JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config.json'), 'utf8')).ai.letterModel);
    const system = arg(argv, '--system-prompt');
    assert.match(system, /professional summary at the top of one candidate's CV, tailored to one job/);
    assert.match(system, /Use ONLY facts in the CV\. Never invent employers, numbers, skills, certifications or years/);
    assert.match(system, /Never make commitments/);
    assert.match(system, /3-4 sentences, 50-90 words, plain text/);
    assert.match(system, /Match the voice of the CV's current SUMMARY/);
    assert.doesNotMatch(system, /REVISION/);
    assert.match(stdin, /CV:\n[\s\S]*SUMMARY: Senior Full Stack Engineer[\s\S]*JOB:\nTITLE: Senior Laravel Developer/);
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['summary']);
  });

  it('aiSummary with feedback sends the current summary and the feedback, and returns the note', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ summary: 'Shorter.', note: 'No Go in the CV.' });
    const res = await aiSummary(job({ cv_summary: 'The current summary.' }), 'mention Go');
    assert.deepEqual(res, { summary: 'Shorter.', note: 'No Go in the CV.' });
    const [{ argv, stdin }] = calls();
    assert.match(arg(argv, '--system-prompt'), /REVISION: the candidate gives you the CURRENT SUMMARY and FEEDBACK/);
    assert.match(stdin, /CURRENT SUMMARY:\nThe current summary\.\n\nFEEDBACK FROM THE CANDIDATE:\nmention Go$/);
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['summary', 'note']);
  });

  it('aiAnswers sends the questions and applicant facts, and forbids guessing personal decisions', async () => {
    const answers = [{ question: 'Notice period?', answer: '[FILL: notice period]', needs_input: true, note: '' }];
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ answers });
    assert.deepEqual(await aiAnswers(job(), 'Notice period?'), answers);
    const [{ argv, stdin }] = calls();
    assert.equal(arg(argv, '--model'), 'sonnet');
    assert.match(stdin, /APPLICANT FACTS[\s\S]*FORM QUESTIONS:\nNotice period\?/);
    assert.match(arg(argv, '--system-prompt'), /never guessed: write \[FILL/);
    assert.match(arg(argv, '--system-prompt'), /expectedSalary for "AE"/);
    // A yes/no answer carries its evidence: the option first, then sentences (never a bare "Yes").
    assert.match(
      arg(argv, '--system-prompt'),
      /start the answer with exactly one of the offered options[\s\S]*then a full stop and 1-2 sentences/,
    );
    assert.match(arg(argv, '--system-prompt'), /Never answer with the bare option alone/);
    assert.match(JSON.parse(arg(argv, '--json-schema')).properties.answers.items.properties.answer.description, /exact option first/);
  });

  it('aiAnswers uses the remote salary for remote jobs', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ answers: [] });
    await aiAnswers(job({ country: 'RM' }), 'Salary?');
    assert.match(arg(calls()[0].argv, '--system-prompt'), /expectedSalary for "remote"/);
  });
});
