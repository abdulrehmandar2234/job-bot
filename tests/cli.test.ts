import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { daysAgo, TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { path } from '../src/config.ts';
import { slug } from '../src/commands/shared.ts';

/** The job's newest applications/<date>-<company>-<title> folder (what prepare and letter write to). */
function applicationDirOf(j: { company: string; title: string }) {
  const name = `${slug(j.company)}-${slug(j.title)}`;
  const hit = readdirSync(path('applications'))
    .filter((d) => d.slice(11) === name)
    .sort()
    .at(-1);
  if (!hit) throw new Error(`no applications folder for ${name}`);
  return path('applications', hit);
}

// Runs the real CLI (same command as `npm run bot`) against the test database with a fake Claude.
const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
// prepare checks that the posting is still open; the fake fetch answers "open" without touching the network.
const FAKE_FETCH = pathToFileURL(join(import.meta.dirname, 'fixtures', 'fake-fetch.mjs')).href;
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-cli-'));
const run = promisify(execFile);

async function bot(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const p = run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: path(),
    env: { ...process.env, DATABASE_URL: TEST_DB, JOB_BOT_CLAUDE: FAKE, NODE_OPTIONS: `--import=${FAKE_FETCH}`, ...env },
    timeout: 60_000,
  });
  if (stdin !== undefined) {
    p.child.stdin!.end(stdin);
  }
  return (await p).stdout;
}

const posting = (o: object = {}) => ({
  source: 'bayt',
  company: 'Testco Cli',
  title: 'Senior Laravel Developer',
  location: 'Dubai, UAE',
  url: 'https://www.bayt.com/en/uae/jobs/test-1/',
  description: 'Laravel, PHP, Vue.js, MySQL, REST APIs and Docker.',
  posted_at: daysAgo(1),
  ...o,
});
const addFile = (jobs: object[]) => {
  const f = join(tmp, `add-${Math.random()}.json`);
  writeFileSync(f, JSON.stringify(jobs));
  return f;
};
const idOf = (out: string) => out.match(/id: (\S+)/)![1];

before(migrate);
beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
});

describe('CLI', () => {
  it('uses the test database, not the real one from .env', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.ok(await getJob(id));
  });

  it('points the HTTP cache outside the repo (tests/helpers.ts), so no test writes data/http-cache', () => {
    const dir = process.env.JOB_BOT_HTTP_CACHE ?? '';
    assert.ok(dir.startsWith(tmpdir()), dir);
    assert.ok(!dir.startsWith(path()), dir);
  });

  it('add scores matching jobs and explains filtered ones', async () => {
    const out = await bot(['add', '--file', addFile([posting(), posting({ url: 'https://www.bayt.com/2', title: 'Sales Manager' })])]);
    assert.match(out, /AE\s+new\s+Testco Cli — Senior Laravel Developer/);
    assert.match(out, /filtered: title is not an engineering role/);
  });

  it('add reads JSON from stdin and gives the same id for the same url', async () => {
    const a = idOf(await bot(['add'], {}, JSON.stringify(posting())));
    const b = idOf(await bot(['add'], {}, JSON.stringify(posting({ title: 'Senior Laravel Developer (PHP)' }))));
    assert.equal(a, b);
    assert.match(a, /^bayt:[0-9a-f]{12}$/);
  });

  it('list, show and stats', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.match(await bot(['list']), /Testco Cli — Senior Laravel Developer/);
    assert.match(await bot(['list', '--country', 'sa']), /No jobs with status=new/);
    const show = await bot(['show', id, '--full']);
    assert.match(show, /Visa: UAE: employer issues work visa/);
    assert.match(show, /Laravel, PHP, Vue\.js/);
    assert.match(await bot(['stats']), /new\s+AE\s+1/);
    assert.match(await bot(['show', 'nope']), /Not found/);
  });

  it('mark changes status with history and rejects bad input', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.match(await bot(['mark', id, 'applied', 'via', 'Bayt']), /→ applied/);
    const { rows } = await pool.query('SELECT to_status, note FROM job_events WHERE job_id = $1', [id]);
    assert.deepEqual(rows, [{ to_status: 'applied', note: 'via Bayt' }]);
    assert.match(await bot(['mark', id, 'hired']), /Usage: mark/);
  });

  it('prepare picks the CV and writes no cover letter, never applies', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const out = await bot(['prepare', id], { FAKE_CLAUDE_FAIL: 'prepare must not call the AI' });
    assert.match(out, /CV version : default/);
    assert.match(out, new RegExp(`Cover {6}: not written yet \\(npm run bot -- letter ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(out, /AI cover letter failed/);
    const j = await getJob(id);
    assert.deepEqual([j.status, j.cv_version, j.cover_letter, j.applied_at], ['prepared', 'default', null, null]);
    const dir = applicationDirOf(j);
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'application.json'), 'utf8'));
      assert.match(meta.cvFile, /cv\/default\/abdulrehman_dar_resume\.pdf$/);
      assert.equal(existsSync(join(dir, 'cover-letter.txt')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('letter writes the AI letter next to the CV notes, and rewrites it; status and CV stay', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await bot(['prepare', id]);
    const letter = 'Dear Testco Cli Hiring Team,\nAI letter';
    const out = await bot(['letter', id], { FAKE_CLAUDE_OUT: JSON.stringify({ letter }) });
    assert.match(out, /written by AI/);
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      assert.equal(dir, applicationDirOf(await getJob(id))); // the folder prepare made
      assert.equal(readFileSync(join(dir, 'cover-letter.txt'), 'utf8'), `${letter}\n`);
      const j = await getJob(id);
      assert.deepEqual([j.status, j.cv_version, j.cover_letter, j.cover_letter_ai], ['prepared', 'default', `${letter}\n`, true]);
      await bot(['letter', id], { FAKE_CLAUDE_OUT: JSON.stringify({ letter: 'Dear Testco Cli Hiring Team,\nSecond' }) });
      assert.match((await getJob(id)).cover_letter!, /Second/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('letter falls back to the template when AI fails; prepare --letter writes both at once', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const out = await bot(['letter', id], { FAKE_CLAUDE_FAIL: 'offline' });
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      assert.match(out, /AI cover letter failed, using template/);
      assert.match((await getJob(id)).cover_letter!, /^Dear Testco Cli Hiring Team,/);
      assert.equal((await getJob(id)).cover_letter_ai, false);
      assert.match(await bot(['letter', 'nope']), /Not found/);

      const both = await bot(['prepare', id, '--letter', '--template']);
      assert.match(both, /CV version : default[\s\S]*Cover {6}: \S+\/cover-letter\.txt \(template\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ai:score stores the review', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const review = { score: 87, verdict: 'strong', summary: 'Apply', reasons: ['Laravel'], gaps: [], red_flags: ['Arabic plus'] };
    assert.match(await bot(['ai:score', '--id', id], { FAKE_CLAUDE_OUT: JSON.stringify(review) }), /87 strong/);
    const j = (await getJob(id)) as unknown as Record<string, unknown>;
    assert.equal(j.ai_score, 87);
    assert.deepEqual(j.ai_flags, ['Arabic plus']);
    assert.match(await bot(['ai:score']), /Nothing to score/);
  });

  it('answer drafts, replaces re-asked questions, and clears', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const q = join(tmp, 'q.txt');
    writeFileSync(q, 'Notice period?\nYears with Laravel?');
    const first = [
      { question: 'Notice period?', answer: '[FILL: notice period]', needs_input: true, note: '' },
      { question: 'Years with Laravel?', answer: 'about 7 years', needs_input: false, note: '' },
    ];
    const out = await bot(['answer', id, '--file', q], { FAKE_CLAUDE_OUT: JSON.stringify({ answers: first }) });
    assert.match(out, /A: about 7 years/);
    assert.match(out, /1 answer\(s\) need your input/);

    const again = [{ question: 'notice period', answer: '1 month', needs_input: false, note: '' }];
    await bot(['answer', id], { FAKE_CLAUDE_OUT: JSON.stringify({ answers: again }) }, 'Notice period');
    assert.deepEqual(
      (await getJob(id)).form_answers.map((a) => a.answer),
      ['about 7 years', '1 month'],
    );

    assert.match(await bot(['answer', id, '--clear']), /Answers cleared/);
    assert.deepEqual((await getJob(id)).form_answers, []);
    assert.match(await bot(['answer', id], {}, '  '), /No questions given/);
  });

  it('rescore re-applies the filters without downloading', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await pool.query(`UPDATE jobs SET posted_at = now() - interval '40 days' WHERE id = $1`, [id]);
    assert.match(await bot(['rescore']), /1 jobs re-scored/);
    assert.match((await getJob(id)).filter_reason!, /posted 40 days ago/);
  });

  it('groups duplicates after adding', async () => {
    const out = await bot([
      'add',
      '--file',
      addFile([posting(), posting({ source: 'linkedin', url: 'https://www.linkedin.com/jobs/view/1/' })]),
    ]);
    assert.match(out, /1 duplicate postings grouped/);
  });

  it('prints help for unknown commands', async () => {
    assert.match(await bot(['nope']), /Commands:[\s\S]*answer <id>/);
  });
});

// Exit code and output of a run that may fail.
const botExit = (args: string[], env: Record<string, string> = {}) =>
  bot(args, env).then(
    (stdout) => ({ code: 0, stdout, stderr: '' }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

describe('CLI settings', () => {
  // Never the worktree's own config.json / cv/applicant.json: JOB_BOT_CONFIG / JOB_BOT_APPLICANT point at temp copies.
  const realConfig = readFileSync(path('config.json'), 'utf8');
  const target = () => {
    const d = mkdtempSync(join(tmp, 'settings-'));
    const config = join(d, 'config.json');
    writeFileSync(config, realConfig);
    return { config, applicant: join(d, 'applicant.json'), env: { JOB_BOT_CONFIG: config, JOB_BOT_APPLICANT: join(d, 'applicant.json') } };
  };
  const json = (o: unknown) => {
    const f = join(tmp, `in-${Math.random()}.json`);
    writeFileSync(f, JSON.stringify(o));
    return f;
  };
  const badConfig = () => ({ ...JSON.parse(realConfig), maxAgeDays: 'two weeks' });

  it('settings:check prints {ok:true} for a valid file and errors with paths for a bad one', async () => {
    const t = target();
    const ok = await botExit(['settings:check', '--kind', 'config', '--file', t.config], t.env);
    assert.deepEqual([ok.code, JSON.parse(ok.stdout)], [0, { ok: true }]);
    const bad = await botExit(['settings:check', '--kind', 'config', '--file', json(badConfig())], t.env);
    assert.equal(bad.code, 1);
    assert.deepEqual(JSON.parse(bad.stdout), {
      ok: false,
      errors: [{ path: 'maxAgeDays', message: 'Invalid input: expected number, received string' }],
    });
    const example = await botExit(['settings:check', '--kind', 'applicant', '--file', path('cv', 'applicant.example.json')], t.env);
    assert.deepEqual(JSON.parse(example.stdout), { ok: true });
  });

  it('settings:check reports bad --kind, missing files and invalid JSON as JSON errors', async () => {
    const t = target();
    const kind = await botExit(['settings:check', '--kind', 'cv', '--file', t.config], t.env);
    assert.deepEqual([kind.code, JSON.parse(kind.stdout).errors[0].path], [1, '--kind']);
    const missing = await botExit(['settings:check', '--kind', 'config', '--file', join(tmp, 'nope.json')], t.env);
    assert.deepEqual([missing.code, JSON.parse(missing.stdout).errors[0].path], [1, '--file']);
    const f = join(tmp, 'broken.json');
    writeFileSync(f, '{ "minScore": ');
    const broken = await botExit(['settings:check', '--kind', 'config', '--file', f], t.env);
    assert.equal(broken.code, 1);
    assert.match(JSON.parse(broken.stdout).errors[0].message, /^invalid JSON/);
  });

  it('settings:save replaces the target only when valid', async () => {
    const t = target();
    const changed = { ...JSON.parse(realConfig), minScore: 61 };
    const saved = await botExit(['settings:save', '--kind', 'config', '--file', json(changed)], t.env);
    assert.deepEqual([saved.code, JSON.parse(saved.stdout)], [0, { ok: true }]);
    assert.equal(readFileSync(t.config, 'utf8'), JSON.stringify(changed, null, 2) + '\n');

    const refused = await botExit(['settings:save', '--kind', 'config', '--file', json(badConfig())], t.env);
    assert.equal(refused.code, 1);
    assert.equal(JSON.parse(readFileSync(t.config, 'utf8')).minScore, 61);
    assert.deepEqual(readdirSync(dirname(t.config)), ['config.json']); // no temp file left behind
  });

  it('settings:save --kind applicant writes the applicant file, from stdin too', async () => {
    const t = target();
    const facts = { noticePeriod: '1 month', expectedSalary: { AE: 'AED 25,000' } };
    const p = run(process.execPath, ['--no-warnings', 'src/cli.ts', 'settings:save', '--kind', 'applicant'], {
      cwd: path(),
      env: { ...process.env, ...t.env },
    });
    p.child.stdin!.end(JSON.stringify(facts));
    assert.deepEqual(JSON.parse((await p).stdout), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(t.applicant, 'utf8')), facts);
  });

  it('an invalid config.json stops other commands with the file and field, but settings commands still work', async () => {
    const t = target();
    writeFileSync(t.config, JSON.stringify(badConfig()));
    const list = await botExit(['list'], t.env);
    assert.equal(list.code, 1);
    assert.ok(list.stderr.includes(`Invalid settings file ${t.config}:\n  - maxAgeDays: Invalid input: expected number`));
    const fixed = await botExit(['settings:save', '--kind', 'config', '--file', json(JSON.parse(realConfig))], t.env);
    assert.deepEqual(JSON.parse(fixed.stdout), { ok: true });
    assert.equal((await botExit(['list'], t.env)).code, 0);
  });

  it('answer refuses an invalid applicant file with a clear message', async () => {
    const t = target();
    writeFileSync(t.applicant, JSON.stringify({ noticePeriod: ['1 month'] }));
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const q = join(tmp, 'q-applicant.txt');
    writeFileSync(q, 'Notice period?');
    const out = await botExit(['answer', id, '--file', q], { ...t.env, FAKE_CLAUDE_OUT: JSON.stringify({ answers: [] }) });
    assert.equal(out.code, 1);
    assert.match(out.stderr, /Invalid settings file .*applicant\.json:\n {2}- noticePeriod: /);
  });
});

describe('CLI with an API AI provider', () => {
  // ai:score end to end with the API provider: a temp config.json picks it, the preloaded fake fetch
  // (tests/fixtures/fake-fetch.mjs) answers the chat API, and a dummy key stands in. Nothing reaches the network.
  const review = {
    score: 88,
    verdict: 'strong',
    summary: 'Apply',
    reasons: ['Laravel'],
    gaps: [],
    red_flags: [],
    location: { eligible: 'yes', reason: 'Dubai onsite' },
  };
  const chat = (content: object) => ({ body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
  const withAi = (ai: object) => {
    const cfg = JSON.parse(readFileSync(path('config.json'), 'utf8'));
    const f = join(mkdtempSync(join(tmp, 'provider-')), 'config.json');
    writeFileSync(f, JSON.stringify({ ...cfg, ai: { ...cfg.ai, ...ai } }));
    return f;
  };
  // Empty values hide any key in the worktree's own env file (the environment wins over --env-file).
  const noKeys = { AI_API_KEY: '', AI_BASE_URL: '', OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '' };

  for (const [label, ai, env, url, name, model] of [
    [
      'an Anthropic AI_API_KEY (detected)',
      { provider: 'api' },
      { AI_API_KEY: 'sk-ant-test-cli-0123456789' },
      'https://api.anthropic.com/v1/chat/completions',
      'Anthropic',
      'claude-haiku-5-5',
    ],
    [
      'AI_API_KEY with preset deepseek',
      { provider: 'api', api: { preset: 'deepseek' } },
      { AI_API_KEY: 'sk-test-cli-0123456789' },
      'https://api.deepseek.com/chat/completions',
      'DeepSeek',
      'deepseek-chat',
    ],
    [
      'the older "openai" provider and OPENAI_API_KEY',
      { provider: 'openai' },
      { OPENAI_API_KEY: 'sk-test-cli-0123456789' },
      'https://api.openai.com/v1/chat/completions',
      'OpenAI',
      'gpt-4o-mini',
    ],
  ] as const) {
    it(`ai:score --id stores the review with ${label}`, async () => {
      const id = idOf(await bot(['add', '--file', addFile([posting()])]));
      const log = join(tmp, `fetch-${Math.random()}.log`);
      const out = await bot(['ai:score', '--id', id], {
        ...noKeys,
        ...env,
        JOB_BOT_CONFIG: withAi(ai),
        FAKE_FETCH: JSON.stringify({ [url]: chat(review) }),
        FAKE_FETCH_LOG: log,
        FAKE_CLAUDE_FAIL: 'the Claude CLI must not be used',
      });
      assert.match(out, new RegExp(`AI scoring 1 jobs with ${name} ${model}`));
      assert.match(out, /88 strong/);
      assert.ok(!out.includes('sk-'));
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [url]);
      const j = (await getJob(id)) as unknown as Record<string, unknown>;
      assert.deepEqual([j.ai_score, j.ai_verdict, j.ai_location], [88, 'strong', 'yes']);
    });
  }

  it('ai:score --id with the API provider but no key fails naming AI_API_KEY, before any request', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const log = join(tmp, 'fetch-nokey.log');
    const res = await botExit(['ai:score', '--id', id], { ...noKeys, JOB_BOT_CONFIG: withAi({ provider: 'api' }), FAKE_FETCH_LOG: log });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /No AI API key: set AI_API_KEY in \.env/);
    assert.equal(existsSync(log), false);
    assert.equal(((await getJob(id)) as unknown as Record<string, unknown>).ai_score, null);
  });
});
