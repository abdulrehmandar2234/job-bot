import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mockFetch, OWNER_MASTER } from './helpers.ts';
import { aiAnswers, aiCheckLetter, aiCoverLetter, aiHeadline, aiScore, aiSummary, applicantFacts, cvText } from '../src/ai.ts';
import { AI_BUDGET, AiError, askClaude, CLI_KILL_GRACE_MS } from '../src/ai-providers.ts';
import { aiScore as aiScoreCommand, MAX_TIMEOUTS_IN_A_ROW } from '../src/commands/ai.ts';
import { config } from '../src/config.ts';
import { migrate, pool, type Job } from '../src/db.ts';
import { timing } from '../src/sources/http.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
let log: string;

beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), 'jobbot-ai-')), 'calls.jsonl');
  Object.assign(process.env, { JOB_BOT_CLAUDE: FAKE, FAKE_CLAUDE_LOG: log });
  delete process.env.FAKE_CLAUDE_FAIL;
  delete process.env.FAKE_CLAUDE_HANG;
  delete process.env.FAKE_CLAUDE_EXIT_EARLY;
});
afterEach(() => {
  delete process.env.JOB_BOT_CLAUDE;
  delete process.env.FAKE_CLAUDE_OUT;
});

const calls = () =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { pid: number; argv: string[]; stdin: string });
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

  /** The AiError askClaude rejects with (never a plain Error: the CLI would print a stack trace). */
  const failure = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => assert.fail('expected a rejection'),
      (x) => x,
    );
    assert.ok(e instanceof AiError, `not an AiError: ${e}`);
    return e as AiError;
  };

  it('a CLI error is an AiError with its message and the sign-in hint; signed out or a usage limit is fatal', async () => {
    process.env.FAKE_CLAUDE_FAIL = 'Not logged in · Please run /login';
    let e = await failure(askClaude('x', {}, 'haiku', ''));
    assert.equal(
      e.message,
      'Claude CLI error: Not logged in · Please run /login. If you are signed out, run `claude` once in a terminal to sign in.',
    );
    assert.deepEqual([e.fatal, e.timedOut], [true, false]);
    process.env.FAKE_CLAUDE_FAIL = 'Claude AI usage limit reached|1700000000';
    e = await failure(askClaude('x', {}, 'haiku', ''));
    assert.match(e.message, /usage limit reached/);
    assert.equal(e.fatal, true);
    // Anything else may be about this one prompt: not fatal, a batch goes on.
    process.env.FAKE_CLAUDE_FAIL = 'Prompt is too long';
    e = await failure(askClaude('x', {}, 'haiku', ''));
    assert.match(e.message, /^Claude CLI error: Prompt is too long\. If you are signed out/);
    assert.equal(e.fatal, false);
  });

  it('a CLI that is not installed is a fatal AiError naming the path and ai.claudePath', async () => {
    process.env.JOB_BOT_CLAUDE = '/nonexistent/claude';
    const e = await failure(askClaude('x', {}, 'haiku', ''));
    assert.match(e.message, /^Claude CLI not found at \/nonexistent\/claude: install Claude Code, or set ai\.claudePath in config\.json/);
    assert.equal(e.fatal, true);
  });

  it('a CLI that exits before reading the prompt fails cleanly (no EPIPE crash), with its stderr', async () => {
    process.env.FAKE_CLAUDE_EXIT_EARLY = 'Error: not logged in';
    // A prompt larger than the pipe buffer, so writing it really hits the closed pipe.
    const e = await failure(askClaude('x'.repeat(4 * 1024 * 1024), {}, 'haiku', ''));
    assert.match(e.message, /^Claude CLI error: Claude CLI exited 1 Error: not logged in\. If you are signed out/);
    assert.equal(e.fatal, true);
  });

  it('a timed-out CLI that ignores SIGTERM is SIGKILLed after the grace', async () => {
    process.env.FAKE_CLAUDE_HANG = '1';
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const e = await failure(askClaude('x', {}, 'haiku', '', undefined, 300));
    assert.equal(e.message, 'Claude CLI gave no answer within 0.3s');
    assert.deepEqual([e.timedOut, e.fatal], [true, false]);
    // The fake logged its pid before hanging; SIGTERM alone must not have ended it, SIGKILL after the grace does.
    const until = Date.now() + CLI_KILL_GRACE_MS + 5000;
    while (!existsSync(log) && Date.now() < until) await wait(25);
    const [{ pid }] = calls();
    while (alive(pid) && Date.now() < until) await wait(50);
    assert.equal(alive(pid), false, 'the wedged CLI was SIGKILLed');
  });
});

describe('prompts', () => {
  it('cvText contains the CV facts', () => {
    const t = cvText();
    assert.match(t, /Abdul Rehman Dar/);
    assert.match(t, /EXPERIENCE: Senior Software Engineer, Qureos/);
    assert.match(t, /SKILLS: .*Laravel/);
  });

  it('cvText is cached per master file and mtime, so concurrent scoring workers do not re-read it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'jobbot-master-')), 'master.json');
    const original = readFileSync(join(import.meta.dirname, 'fixtures', 'master-owner.json'), 'utf8');
    const stamp = new Date('2026-01-01T00:00:00Z');
    writeFileSync(file, original);
    utimesSync(file, stamp, stamp);
    process.env.JOB_BOT_MASTER = file;
    try {
      const first = cvText();
      writeFileSync(file, JSON.stringify({ ...JSON.parse(original), title: 'Changed Title For The Cache Test' }));
      utimesSync(file, stamp, stamp); // same mtime: the cache answers without reading the file again
      assert.equal(cvText(), first);
      const later = new Date('2026-01-02T00:00:00Z'); // a new mtime invalidates the cache
      utimesSync(file, later, later);
      assert.match(cvText(), /Changed Title For The Cache Test/);
    } finally {
      process.env.JOB_BOT_MASTER = OWNER_MASTER; // what tests/helpers.ts set, for the tests after this one
    }
  });

  it('applicantFacts never sends the help text and keeps unknowns null', () => {
    const facts = JSON.parse(applicantFacts());
    assert.equal(facts._help, undefined);
    assert.equal(facts.languages, 'English, Urdu');
    assert.ok('noticePeriod' in facts);
  });

  it('applicantFacts leaves out the birth date and year (only for the Dutch visa salary check)', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'talaash-birth-')), 'applicant.json');
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(process.env.JOB_BOT_APPLICANT!, 'utf8')), birthDate: '1995-06-01', birthYear: 1995 }),
    );
    const before = process.env.JOB_BOT_APPLICANT;
    process.env.JOB_BOT_APPLICANT = file;
    try {
      const facts = JSON.parse(applicantFacts());
      assert.equal(facts.birthYear, undefined);
      assert.equal(facts.birthDate, undefined);
      assert.equal(facts.languages, 'English, Urdu');
    } finally {
      process.env.JOB_BOT_APPLICANT = before;
    }
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

  it('aiCheckLetter sends the CV, the job and the letter, and returns the fixed letter with what it fixed', async () => {
    const problem = "Claims Kubernetes experience ('deployed with Kubernetes'), which the CV does not show.";
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ problems: [` ${problem} `, ' '], letter: ' Dear Acme Hiring Team,\nFixed ' });
    const res = await aiCheckLetter(job(), 'Dear Acme Hiring Team,\nI deployed with Kubernetes.\n');
    assert.deepEqual(res, { problems: [problem], letter: 'Dear Acme Hiring Team,\nFixed\n' });
    const [{ argv, stdin }] = calls();
    assert.equal(arg(argv, '--model'), 'sonnet');
    assert.match(stdin, /CV:[\s\S]*JOB:[\s\S]*LETTER:\nDear Acme Hiring Team,\nI deployed with Kubernetes\.$/);
    const system = arg(argv, '--system-prompt');
    assert.match(system, /claim about the candidate the CV does not support/);
    assert.match(system, /the JOB text does not state/);
    assert.match(system, /Keep\s+every other word/);
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['problems', 'letter']);
  });

  it('aiCheckLetter keeps the letter exactly as written when nothing is wrong or the fix is empty', async () => {
    const letter = 'Dear Acme Hiring Team,\nAll true.\n';
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ problems: [], letter: 'Dear Acme Hiring Team,\nReworded anyway.' });
    assert.deepEqual(await aiCheckLetter(job(), letter), { problems: [], letter });
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ problems: ['Something'], letter: '  ' });
    assert.deepEqual(await aiCheckLetter(job(), letter), { problems: ['Something'], letter });
  });

  it('aiSummary writes a summary for the job with the letter model and the truthfulness rules', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ summary: '  Senior engineer with\n7+ years of Laravel.  ' });
    assert.deepEqual(await aiSummary(job()), { summary: 'Senior engineer with 7+ years of Laravel.', note: '' });
    const [{ argv, stdin }] = calls();
    assert.equal(
      arg(argv, '--model'),
      JSON.parse(readFileSync(join(import.meta.dirname, '..', 'config.default.json'), 'utf8')).ai.letterModel,
    );
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

  it("aiHeadline asks for one line of CV facts in the job's words, and cleans the reply", async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ headline: '  "Senior Laravel Engineer ·\n PHP & MySQL."  ' });
    assert.deepEqual(await aiHeadline(job()), { headline: 'Senior Laravel Engineer · PHP & MySQL', note: '' });
    const [{ argv, stdin }] = calls();
    const system = arg(argv, '--system-prompt');
    assert.match(system, /You write the headline of one candidate's CV, tailored to one job: the one line under the name/);
    assert.match(system, /Never name a skill, technology, employer, certification or number the CV does not show/);
    assert.match(system, /Keep the seniority the CV shows/);
    assert.match(system, /at most 90 characters/);
    assert.doesNotMatch(system, /REVISION/);
    assert.match(stdin, /CV:\n[\s\S]*JOB:\nTITLE: Senior Laravel Developer/);
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['headline']);
  });

  it('aiHeadline with feedback sends the current headline and the feedback, and returns the note', async () => {
    process.env.FAKE_CLAUDE_OUT = JSON.stringify({ headline: 'Laravel Engineer', note: 'No Go in the CV.' });
    assert.deepEqual(await aiHeadline(job({ cv_headline: 'Senior Laravel Engineer' }), 'mention Go'), {
      headline: 'Laravel Engineer',
      note: 'No Go in the CV.',
    });
    const [{ argv, stdin }] = calls();
    assert.match(arg(argv, '--system-prompt'), /REVISION: the candidate gives you the CURRENT HEADLINE and FEEDBACK/);
    assert.match(stdin, /CURRENT HEADLINE:\nSenior Laravel Engineer\n\nFEEDBACK FROM THE CANDIDATE:\nmention Go$/);
    assert.deepEqual(JSON.parse(arg(argv, '--json-schema')).required, ['headline', 'note']);
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

describe('ai:score stops early', () => {
  const ids = Array.from({ length: 6 }, (_, i) => `aitest:${i + 1}`);
  const savedAi = { ...config.ai };
  let out: string[];
  let err: string[];

  before(migrate);
  after(() => pool.end());
  beforeEach(async () => {
    await pool.query('TRUNCATE jobs, job_events CASCADE');
    for (const id of ids) {
      await pool.query(
        `INSERT INTO jobs (id, source, company, title, country, url, status, score, description)
         VALUES ($1, 'greenhouse', 'Aico', 'Senior Laravel Developer', 'AE', 'https://example.com/' || $1, 'new', 60, 'Laravel and PHP.')`,
        [id],
      );
    }
    out = [];
    err = [];
    mock.method(console, 'log', (...a: unknown[]) => out.push(a.join(' ')));
    mock.method(console, 'error', (...a: unknown[]) => err.push(a.join(' ')));
    config.ai = { ...savedAi, enabled: true, concurrency: 2, maxScorePerRun: ids.length };
  });
  afterEach(() => {
    mock.restoreAll();
    config.ai = { ...savedAi };
    process.exitCode = undefined; // the runs below exit 1 on purpose; the test file itself must not
    delete process.env.AI_API_KEY;
  });
  const scored = async () => (await pool.query('SELECT count(*)::int AS n FROM jobs WHERE ai_scored_at IS NOT NULL')).rows[0].n;

  it('a signed-out Claude CLI: one call per worker, not one per job, one line, exit 1', async () => {
    process.env.FAKE_CLAUDE_FAIL = 'Not logged in · Please run /login';
    await aiScoreCommand([], {});
    assert.equal(calls().length, 2, 'one call per worker (concurrency 2)');
    assert.equal(process.exitCode, 1);
    assert.equal(err.length, 1, err.join('\n'));
    assert.match(
      err[0],
      /^AI review failed for 2 of 6 jobs; stopped early: Claude CLI error: Not logged in · Please run \/login\. If you are signed out, run `claude` once/,
    );
    assert.ok(out.includes('0 jobs scored, 2 failed, 4 not tried.'), out.join('\n'));
    assert.ok(!out.some((l) => l.includes('✗')), 'no per-job error lines');
    assert.equal(await scored(), 0);
  });

  it('a rejected API key (401): one request per worker, the key never printed, exit 1', async () => {
    const key = 'sk-test-ai-score-secret-123';
    process.env.AI_API_KEY = key;
    config.ai = { ...config.ai, provider: 'api', api: {} };
    const net = mockFetch({ 'chat/completions': () => Response.json({ error: { message: 'Incorrect API key' } }, { status: 401 }) });
    try {
      await aiScoreCommand([], {});
    } finally {
      net.restore();
    }
    assert.equal(net.calls.length, 2, 'one request per worker');
    assert.equal(process.exitCode, 1);
    assert.equal(err.length, 1);
    assert.match(err[0], /^AI review failed for 2 of 6 jobs; stopped early: OpenAI rejected the API key \(AI_API_KEY\): 401/);
    assert.ok(![...out, ...err].some((l) => l.includes(key)));
  });

  it(`a provider that keeps timing out: stops after ${MAX_TIMEOUTS_IN_A_ROW} in a row`, async () => {
    process.env.AI_API_KEY = 'sk-test-dummy';
    config.ai = { ...config.ai, provider: 'api', api: {}, concurrency: 1 };
    const saved = AI_BUDGET.ms;
    AI_BUDGET.ms = 30;
    timing.scale = 0;
    const net = mockFetch({
      'chat/completions': (_u: string, init?: RequestInit) =>
        new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))),
    });
    try {
      await aiScoreCommand([], {});
    } finally {
      net.restore();
      AI_BUDGET.ms = saved;
      timing.scale = 1;
    }
    assert.equal(net.calls.length, MAX_TIMEOUTS_IN_A_ROW);
    assert.equal(process.exitCode, 1);
    assert.equal(err.length, 1);
    assert.match(
      err[0],
      /^AI review failed for 3 of 6 jobs; stopped early: the AI provider is not answering \(3 reviews in a row timed out\), stopping: OpenAI gave no answer/,
    );
    assert.ok(out.includes('0 jobs scored, 3 failed, 3 not tried.'), out.join('\n'));
  });

  it('one job (--id) just fails with the message, as before', async () => {
    process.env.FAKE_CLAUDE_FAIL = 'Not logged in · Please run /login';
    await aiScoreCommand([], { id: ids[0] });
    assert.equal(calls().length, 1);
    assert.equal(process.exitCode, 1);
    assert.equal(err.length, 1);
    assert.match(err[0], /^AI review failed for 1 of 1 job: Claude CLI error: Not logged in/);
  });

  it('an error that is not fatal (one bad reply) does not stop the run', async () => {
    process.env.FAKE_CLAUDE_FAIL = 'Prompt is too long';
    await aiScoreCommand([], {});
    assert.equal(calls().length, ids.length, 'every job was tried');
    assert.equal(process.exitCode, 1, 'the whole queue failed');
    assert.match(err[0], /^AI review failed for 6 of 6 jobs: Claude CLI error: Prompt is too long/);
  });
});
