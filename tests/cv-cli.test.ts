import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChrome } from '../src/cv/chrome.ts';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { daysAgo, TEST_DB } from './helpers.ts';
import { getJob, migrate, pool } from '../src/db.ts';
import { config, path } from '../src/config.ts';
import type { Cv } from '../src/cv/render.ts';

// The CV template and CV feedback commands, through the real CLI against the test database, with a fake Claude and
// the example master CV (cv/master.example.json). Every CV version a test builds is removed afterwards.

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-claude.mjs');
const FAKE_FETCH = pathToFileURL(join(import.meta.dirname, 'fixtures', 'fake-fetch.mjs')).href;
const MASTER = path('cv', 'master.example.json');
const master = JSON.parse(readFileSync(MASTER, 'utf8')) as Cv;
const tmp = mkdtempSync(join(tmpdir(), 'jobbot-cv-cli-'));
const run = promisify(execFile);
const noChrome = !resolveChrome(config.chromePath) && 'Chrome not installed';

async function bot(args: string[], env: Record<string, string> = {}) {
  const { stdout } = await run(process.execPath, ['--no-warnings', '--env-file-if-exists=.env', 'src/cli.ts', ...args], {
    cwd: path(),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB,
      JOB_BOT_CLAUDE: FAKE,
      JOB_BOT_MASTER: MASTER,
      NODE_OPTIONS: `--import=${FAKE_FETCH}`,
      ...env,
    },
    timeout: 60_000,
  });
  return stdout;
}
/** Runs the CLI expecting it to fail; returns stderr and the exit code. */
const fails = (args: string[], env: Record<string, string> = {}) =>
  bot(args, env).then(
    (out) => assert.fail(`expected a failure, got: ${out}`),
    (e: { stderr: string; code: number }) => ({ stderr: e.stderr, code: e.code }),
  );

async function addJob(company: string) {
  const f = join(tmp, `add-${Math.random()}.json`);
  const posting = {
    source: 'bayt',
    company,
    title: 'Senior React Developer',
    location: 'Dubai, UAE',
    url: `https://www.bayt.com/en/uae/jobs/${encodeURIComponent(company)}/`,
    description: 'React, Next.js, Node.js, PostgreSQL and REST APIs.',
    posted_at: daysAgo(1),
  };
  writeFileSync(f, JSON.stringify([posting]));
  return (await bot(['add', '--file', f])).match(/id: (\S+)/)![1];
}

// cv/versions/ before the tests: anything new afterwards was made by a test and is removed.
const VERSIONS = path('cv', 'versions');
const existing = new Set(existsSync(VERSIONS) ? readdirSync(VERSIONS) : []);
const meta = (id: string) => JSON.parse(readFileSync(path('cv', 'versions', id, 'meta.json'), 'utf8'));
const cvJson = (id: string) => JSON.parse(readFileSync(path('cv', 'versions', id, 'cv.json'), 'utf8')) as Cv;
const versionOf = (out: string) => out.match(/CV version : (\S+)/)![1];

before(migrate);
beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
after(async () => {
  await pool.end();
  rmSync(tmp, { recursive: true, force: true });
  if (existsSync(VERSIONS))
    for (const d of readdirSync(VERSIONS)) if (!existing.has(d)) rmSync(join(VERSIONS, d), { recursive: true, force: true });
});

describe('cv:templates and cv:preview', () => {
  it('cv:templates lists every template and marks the default', async () => {
    const out = await bot(['cv:templates']);
    for (const t of ['classic', 'modern', 'compact']) assert.match(out, new RegExp(`^${t}\\s`, 'm'));
    assert.match(out, new RegExp(`^${config.cvTemplate ?? 'classic'} .*\\(default\\)$`, 'm'));
  });

  it('cv:preview prints the master CV in a template as HTML, and refuses an unknown template', async () => {
    const html = await bot(['cv:preview', 'modern']);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<header>\s*<h1>Jane Doe<\/h1>/);
    const bad = await fails(['cv:preview', 'fancy']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /one of: classic, modern, compact/);
  });

  it('cv:preview --pdf prints into previews/ in the data dir (JOB_BOT_DATA_DIR)', { skip: noChrome }, async () => {
    const data = mkdtempSync(join(tmpdir(), 'talaash-preview-data-'));
    try {
      const out = await bot(['cv:preview', 'compact', '--pdf'], { JOB_BOT_DATA_DIR: data });
      const file = join(data, 'previews', 'compact.pdf');
      assert.ok(out.includes(`PDF        : ${file}`), out);
      assert.equal(readFileSync(file).subarray(0, 4).toString(), '%PDF');
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('cv:template', () => {
  it('refuses an unknown template and an unknown job', async () => {
    const id = await addJob('Templateco Bad');
    const bad = await fails(['cv:template', id, 'fancy']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Usage: cv:template <id> <template>/);
    assert.equal((await getJob(id))!.cv_template, null);
    await assert.rejects(
      bot(['cv:template', 'nope', 'modern']),
      (e: { code: number; stderr: string }) => e.code === 1 && /Not found/.test(e.stderr),
    );
  });

  it('only sets the template for a job without a CV; prepare then builds the CV in it', { skip: noChrome }, async () => {
    const id = await addJob('Templateco Prep');
    assert.match(await bot(['cv:template', id, 'compact']), /Template {3}: compact \(no CV yet/);
    let j = await getJob(id);
    assert.deepEqual([j!.cv_template, j!.cv_version], ['compact', null]);

    const out = await bot(['prepare', id]);
    assert.match(out, /Template {3}: compact/);
    j = await getJob(id);
    assert.match(j!.cv_version!, /-compact-v\d+$/);
    assert.equal(meta(j!.cv_version!).template, 'compact');
  });

  it('re-renders the CV as a new version and never touches the old one', { skip: noChrome }, async () => {
    const id = await addJob('Templateco Switch');
    await pool.query(`UPDATE jobs SET cv_version = 'default' WHERE id = $1`, [id]);
    const out = await bot(['cv:template', id, 'modern']);
    const v = versionOf(out);
    assert.match(v, /^default-modern-v\d+$/);
    assert.match(out, /\(was default, kept as it is\)/);
    assert.deepEqual([meta(v).template, meta(v).cluster], ['modern', 'default']);
    assert.equal(
      readFileSync(out.match(/CV file {4}: (\S+)/)![1])
        .subarray(0, 5)
        .toString(),
      '%PDF-',
    );
    let j = await getJob(id);
    assert.deepEqual([j!.cv_template, j!.cv_version], ['modern', v]);

    // The same template again changes nothing.
    assert.match(await bot(['cv:template', id, 'modern']), /already uses it/);
    assert.equal((await getJob(id))!.cv_version, v);

    // A one-off CV keeps its content: a new custom folder in the new template, the old folder unchanged.
    await pool.query(`UPDATE jobs SET cv_summary = 'React engineer for Templateco.', cv_headline = 'Senior React Engineer' WHERE id = $1`, [
      id,
    ]);
    const tailoredOut = await bot(['cv:tailor', id]);
    assert.match(tailoredOut, /\(with the CV headline and summary for this job\)/);
    const tailored = versionOf(tailoredOut);
    assert.deepEqual([cvJson(tailored).title, cvJson(tailored).summary], ['Senior React Engineer', 'React engineer for Templateco.']);
    assert.equal(meta(tailored).template, 'modern', 'cv:tailor uses the job template');
    const before = readFileSync(path('cv', 'versions', tailored, config.cvFileName));
    const again = versionOf(await bot(['cv:template', id, 'compact']));
    assert.match(again, /^custom-templateco-switch-senior-react-develo/);
    assert.notEqual(again, tailored);
    assert.deepEqual(cvJson(again), cvJson(tailored));
    assert.deepEqual([meta(again).template, meta(again).jobId], ['compact', id]);
    assert.deepEqual(readFileSync(path('cv', 'versions', tailored, config.cvFileName)), before, 'the sent CV is untouched');
    j = await getJob(id);
    assert.deepEqual([j!.cv_template, j!.cv_version], ['compact', again]);
  });
});

describe('cv:feedback', () => {
  /** What the fake AI returns: the master CV reordered, plus an invented skill, employer and summary claim. */
  const proposal = {
    cv: {
      title: 'Senior React Engineer',
      summary: 'React engineer with 5 years of experience.',
      skills: [
        { group: 'Frameworks & Libraries', items: ['React.js', 'Next.js', 'Kubernetes'] },
        { group: 'Languages & Runtimes', items: ['TypeScript'] },
      ],
      experience: [
        { company: 'Google', role: 'Staff Engineer', bullets: ['Led search.'] },
        { company: 'Sample Agency', role: 'Front-end Developer', bullets: [master.experience[1].bullets[0]] },
        { company: 'Example Travel', role: 'Full Stack Engineer', bullets: master.experience[0].bullets },
      ],
      projects: [],
    },
    note: 'Left out Kubernetes: the CV does not show it.',
  };

  it('saves the revised CV as a new version, strips what the master lacks and prints the note', { skip: noChrome }, async () => {
    const id = await addJob('Feedbackco Cli');
    await pool.query(`UPDATE jobs SET cv_template = 'compact' WHERE id = $1`, [id]);
    const log = join(tmp, 'claude.jsonl');
    const out = await bot(['cv:feedback', id, '--feedback=--put Sample Agency first'], {
      FAKE_CLAUDE_OUT: JSON.stringify(proposal),
      FAKE_CLAUDE_LOG: log,
    });
    const v = versionOf(out);
    assert.match(v, /^custom-feedbackco-cli-senior-react-developer-v\d+$/);
    assert.match(out, /\(revised by AI with your feedback\)\n/);
    assert.match(out, /Template {3}: compact/);
    assert.match(out, /Note {7}: Left out Kubernetes: the CV does not show it\./);
    assert.match(out, /Left out {3}: Skill "Kubernetes" \(not on your master CV\)/);
    assert.match(out, /Left out {3}: Employer "Google" \(not on your master CV\)/);

    const cv = cvJson(v);
    assert.equal(cv.title, 'Senior React Engineer');
    assert.deepEqual(
      cv.experience.map((e) => e.company),
      ['Sample Agency', 'Example Travel'],
    );
    assert.deepEqual(cv.skills[0].items, ['React.js', 'Next.js']);
    assert.deepEqual(cv.projects, []);
    assert.deepEqual([meta(v).template, meta(v).jobId], ['compact', id]);
    assert.deepEqual(meta(v).feedbackNote, [
      'Left out Kubernetes: the CV does not show it.',
      'Skill "Kubernetes" (not on your master CV)',
      'Employer "Google" (not on your master CV)',
    ]);
    assert.equal((await getJob(id))!.cv_version, v);

    const { argv, stdin } = JSON.parse(readFileSync(log, 'utf8').trim()) as { argv: string[]; stdin: string };
    assert.match(argv[argv.indexOf('--system-prompt') + 1], /Never add an employer, role, skill/);
    assert.match(stdin, /^MASTER CV:\n[\s\S]*"Example Travel"[\s\S]*CURRENT CV FOR THIS JOB:[\s\S]*JOB:\nTITLE: Senior React Developer/);
    assert.match(stdin, /FEEDBACK FROM THE CANDIDATE:\n--put Sample Agency first$/);

    // A second round starts from the CV just made and makes another new folder.
    const second = versionOf(
      await bot(['cv:feedback', id, '--feedback', 'shorter'], { FAKE_CLAUDE_OUT: JSON.stringify({ ...proposal, note: '' }) }),
    );
    assert.notEqual(second, v);
    assert.equal(meta(second).feedbackNote?.length, 2, 'only what this round left out');
    assert.equal((await getJob(id))!.cv_version, second);
    assert.ok(existsSync(path('cv', 'versions', v, config.cvFileName)), 'the first revision stays');
  });

  it('works with only an API key: the Claude CLI is never run', { skip: noChrome }, async () => {
    const id = await addJob('Feedbackco Api');
    const cfg = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
    const configFile = join(mkdtempSync(join(tmpdir(), 'cv-api-')), 'config.json');
    writeFileSync(configFile, JSON.stringify({ ...cfg, ai: { ...cfg.ai, provider: 'api' } }));
    const url = 'https://api.anthropic.com/v1/chat/completions';
    const log = join(tmp, 'cv-api-fetch.log');
    const out = await bot(['cv:feedback', id, '--feedback', 'put Sample Agency first'], {
      JOB_BOT_CONFIG: configFile,
      AI_API_KEY: 'sk-ant-test-cv-0123456789',
      AI_BASE_URL: '',
      FAKE_FETCH: JSON.stringify({ [url]: { body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal) } }] }) } }),
      FAKE_FETCH_LOG: log,
      FAKE_CLAUDE_FAIL: 'the Claude CLI must not be used',
    });
    assert.match(versionOf(out), /^custom-feedbackco-api-/);
    assert.ok(!out.includes('sk-ant-test'));
    assert.deepEqual([...new Set(readFileSync(log, 'utf8').trim().split('\n'))], [url]);
  });

  it('needs feedback of at most 1000 characters, the AI on, and leaves the CV alone when the AI fails', async () => {
    const id = await addJob('Feedbackco Bad');
    await pool.query(`UPDATE jobs SET cv_version = 'default' WHERE id = $1`, [id]);
    for (const args of [[], ['--feedback'], ['--feedback', 'x'.repeat(1001)]]) {
      const res = await fails(['cv:feedback', id, ...args]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /--feedback/);
    }
    const failed = await fails(['cv:feedback', id, '--feedback', 'shorter'], { FAKE_CLAUDE_FAIL: 'offline' });
    assert.match(failed.stderr, /AI CV revision failed, the CV is unchanged: .*offline/);
    assert.equal((await getJob(id))!.cv_version, 'default');
    await assert.rejects(
      bot(['cv:feedback', 'nope', '--feedback', 'shorter']),
      (e: { code: number; stderr: string }) => e.code === 1 && /Not found/.test(e.stderr),
    );
  });
});

describe('cv:feedback --add-skills', () => {
  it('adds the confirmed skills to the master CV with a backup, and the revised CV keeps them', { skip: noChrome }, async () => {
    const id = await addJob('Skillsco Cli');
    const file = join(tmp, 'master-skills.json');
    writeFileSync(file, readFileSync(MASTER));
    const backups = join(tmp, 'cv-backups');
    const log = join(tmp, 'claude-skills.jsonl');
    const proposal = {
      cv: {
        ...master,
        skills: [
          { group: 'DevOps & Tools', items: ['Kubernetes', 'Docker'] },
          ...master.skills.filter((g) => g.group !== 'DevOps & Tools'),
        ],
        projects: master.projects.map((p) => p.name),
      },
      note: '',
    };
    const out = await bot(['cv:feedback', id, '--add-skills=Kubernetes,Docker'], {
      JOB_BOT_MASTER: file,
      JOB_BOT_CV_BACKUP_DIR: backups,
      FAKE_CLAUDE_OUT: JSON.stringify(proposal),
      FAKE_CLAUDE_LOG: log,
    });
    assert.match(out, /Master CV {2}: added Kubernetes \(the CV before: .*cv-backups\/master-.*\.json\)/);
    assert.match(out, /Master CV {2}: already shows Docker/);
    assert.deepEqual(
      readdirSync(backups).map((f) => readFileSync(join(backups, f), 'utf8')),
      [readFileSync(MASTER, 'utf8')],
    );
    const devops = (JSON.parse(readFileSync(file, 'utf8')) as Cv).skills.find((g) => g.group === 'DevOps & Tools')!;
    assert.deepEqual(devops.items, ['Docker', 'AWS', 'Git', 'Kubernetes']);

    const v = versionOf(out);
    assert.deepEqual(cvJson(v).skills[0], { group: 'DevOps & Tools', items: ['Kubernetes', 'Docker'] }, 'not left out');
    assert.equal(meta(v).feedbackNote, undefined);
    const { stdin } = JSON.parse(readFileSync(log, 'utf8').trim()) as { stdin: string };
    assert.match(stdin, /"Kubernetes"[\s\S]*FEEDBACK FROM THE CANDIDATE:\nI have these skills, now on my master CV: Kubernetes, Docker\./);
  });

  it('refuses unknown skills and changes nothing', async () => {
    const id = await addJob('Skillsco Bad');
    const res = await fails(['cv:feedback', id, '--add-skills=Cobol']);
    assert.match(res.stderr, /Unknown skill: Cobol/);
    assert.equal((await getJob(id))!.cv_version, null);
  });
});

describe('cv:review', () => {
  it('stores the AI review on the job and changes nothing else', async () => {
    const id = await addJob('Reviewco Cli');
    const review = '- Lead with the Next.js booking platform.\n- The job asks for Kubernetes, which your CV does not show.';
    const out = await bot(['cv:review', id], { FAKE_CLAUDE_OUT: JSON.stringify({ review }) });
    assert.match(out, /CV review {2}: \(master CV\)\n- Lead with/);
    const j = await getJob(id);
    assert.equal(j!.cv_review, review);
    assert.ok(j!.cv_review_at instanceof Date);
    assert.equal(j!.cv_version, null);

    const failed = await fails(['cv:review', id], { FAKE_CLAUDE_FAIL: 'offline' });
    assert.match(failed.stderr, /AI CV review failed/);
    assert.equal((await getJob(id))!.cv_review, review);
  });
});
