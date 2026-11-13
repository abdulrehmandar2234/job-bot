import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChrome } from '../src/cv/chrome.ts';
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
    assert.match(show, /Visa: UAE: posting does not mention visa or relocation/);
    assert.match(show, /Laravel, PHP, Vue\.js/);
    assert.match(await bot(['stats']), /new\s+AE\s+1/);
    await expectNotFound(['show', 'nope']);
  });

  it('migrate applies pending migrations and says when there are none (the dashboard runs it at startup)', async () => {
    assert.match(await bot(['migrate']), /^Database is up to date\.$/m);
  });

  it('mark changes status with history and rejects bad input', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    assert.match(await bot(['mark', id, 'applied', 'via', 'Bayt']), /→ applied/);
    const { rows } = await pool.query('SELECT to_status, note FROM job_events WHERE job_id = $1', [id]);
    assert.deepEqual(rows, [{ to_status: 'applied', note: 'via Bayt' }]);
    const bad = await botExit(['mark', id, 'hired']);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /Usage: mark/);
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
      assert.match(meta.cvFile, /cv\/default\/resume\.pdf$/);
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
      // The check found nothing (no problems in the reply): the letter is stored as written, and says it was checked.
      assert.deepEqual(j.cover_letter_check, []);
      assert.match(out, /Checked {4}: every claim is in the CV or the posting/);
      await bot(['letter', id], { FAKE_CLAUDE_OUT: JSON.stringify({ letter: 'Dear Testco Cli Hiring Team,\nSecond' }) });
      assert.match((await getJob(id)).cover_letter!, /Second/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('letter stores the checked letter and what the check fixed; ai.checkLetters false skips it', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const problem = "Claims Kubernetes experience ('ran Kubernetes'), which the CV does not show.";
    // The fake AI gives every call the same reply: the letter call reads `letter`, the check reads both.
    const reply = JSON.stringify({ letter: 'Dear Testco Cli Hiring Team,\nFixed letter', problems: [problem] });
    const out = await bot(['letter', id], { FAKE_CLAUDE_OUT: reply });
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      assert.match(out, /Checked {4}: fixed 1 thing the CV or the posting does not support\n {2}- Claims Kubernetes/);
      const j = await getJob(id);
      assert.deepEqual([j.cover_letter, j.cover_letter_check], ['Dear Testco Cli Hiring Team,\nFixed letter\n', [problem]]);

      const cfg = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
      const off = join(mkdtempSync(join(tmpdir(), 'talaash-check-off-')), 'config.json');
      writeFileSync(off, JSON.stringify({ ...cfg, ai: { ...cfg.ai, checkLetters: false } }));
      const log = join(dirname(off), 'calls.jsonl');
      const unchecked = await bot(['letter', id], { FAKE_CLAUDE_OUT: reply, JOB_BOT_CONFIG: off, FAKE_CLAUDE_LOG: log });
      assert.doesNotMatch(unchecked, /Checked/);
      assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1, 'one AI call: the letter, no check');
      assert.equal((await getJob(id)).cover_letter_check, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('letter:pdf prints the letter next to the CV notes; it refuses a job without a letter', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await assert.rejects(bot(['letter:pdf', id]), (e: { stdout: string; code: number }) => {
      assert.match(e.stdout, /No cover letter yet: npm run bot -- letter/);
      assert.equal(e.code, 1);
      return true;
    });
    if (!resolveChrome(JSON.parse(readFileSync(path('config.default.json'), 'utf8')).chromePath)) return;
    const out = await bot(['letter', id, '--template']);
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      const pdf = (await bot(['letter:pdf', id])).match(/PDF {8}: (\S+)/)![1];
      assert.equal(pdf, join(dir, 'cover-letter.pdf'));
      assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
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
      assert.match((await getJob(id)).cover_letter_ai_error!, /offline/, 'the job page says why the AI did not write it');
      await expectNotFound(['letter', 'nope']);

      const both = await bot(['prepare', id, '--letter', '--template']);
      assert.match(both, /CV version : default[\s\S]*Cover {6}: \S+\/cover-letter\.txt \(template\)/);
      assert.equal((await getJob(id)).cover_letter_ai_error, null, 'a template asked for is no AI failure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('letter --feedback rewrites the current letter with the feedback and prints the AI note', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const first = 'Dear Testco Cli Hiring Team,\nThe first, long letter.';
    const out = await bot(['letter', id], { FAKE_CLAUDE_OUT: JSON.stringify({ letter: first }) });
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      await pool.query('UPDATE jobs SET cover_letter_edited_at = now() WHERE id = $1', [id]);
      const log = join(tmp, `claude-${Math.random()}.jsonl`);
      const note = 'The CV does not show Kubernetes, so the letter does not claim it.';
      const second = 'Dear Testco Cli Hiring Team,\nShort.';
      const again = await bot(['letter', id, '--feedback', 'shorter, and mention Kubernetes'], {
        FAKE_CLAUDE_OUT: JSON.stringify({ letter: second, note }),
        FAKE_CLAUDE_LOG: log,
      });
      assert.match(again, /Cover {6}: \S+\/cover-letter\.txt \(rewritten by AI with your feedback\)/);
      assert.match(again, new RegExp(`Note {7}: ${note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      const [{ argv, stdin }] = readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
      assert.match(argv[argv.indexOf('--system-prompt') + 1], /REVISION[\s\S]*say so in "note"/);
      assert.match(
        stdin,
        /CURRENT LETTER:\nDear Testco Cli Hiring Team,\nThe first, long letter\.\n\nFEEDBACK FROM THE CANDIDATE:\nshorter, and mention Kubernetes$/,
      );
      const j = await getJob(id);
      assert.deepEqual([j.cover_letter, j.cover_letter_ai, j.cover_letter_edited_at], [`${second}\n`, true, null]);
      assert.equal(readFileSync(join(dir, 'cover-letter.txt'), 'utf8'), `${second}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('letter --feedback never falls back to the template: an AI failure or bad feedback leaves the letter alone', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const out = await bot(['letter', id, '--template']);
    const dir = out.match(/Cover {6}: (\S+)\/cover-letter\.txt/)![1];
    try {
      const before = (await getJob(id)).cover_letter;
      await assert.rejects(
        bot(['letter', id, '--feedback', 'shorter'], { FAKE_CLAUDE_FAIL: 'offline' }),
        (e: { stderr: string; code: number }) => {
          assert.match(e.stderr, /Could not rewrite the letter, it is unchanged: .*offline/);
          assert.equal(e.code, 1);
          return true;
        },
      );
      for (const bad of [['--feedback'], [`--feedback=${'x'.repeat(1001)}`]])
        await assert.rejects(
          bot(['letter', id, ...bad], { FAKE_CLAUDE_FAIL: 'must not call the AI' }),
          (e: { stderr: string; code: number }) => {
            assert.match(e.stderr, /--feedback needs text of at most 1000 characters/);
            assert.equal(e.code, 1);
            return true;
          },
        );
      assert.equal((await getJob(id)).cover_letter, before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('summary writes a CV summary for the job, rewrites it with feedback and prints the note', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const log = join(tmp, `claude-${Math.random()}.jsonl`);
    const out = await bot(['summary', id], {
      FAKE_CLAUDE_OUT: JSON.stringify({ summary: 'Senior Laravel engineer.' }),
      FAKE_CLAUDE_LOG: log,
    });
    assert.match(out, /CV summary : \(written by AI for this job\)\nSenior Laravel engineer\.\n/);
    assert.match(out, /npm run bot -- cv:tailor/);
    assert.doesNotMatch(out, /Note/);
    let j = await getJob(id);
    assert.equal(j.cv_summary, 'Senior Laravel engineer.');
    assert.ok(j.cv_summary_at instanceof Date);
    assert.deepEqual([j.status, j.cv_version, j.cover_letter], ['new', null, null]);

    await pool.query('UPDATE jobs SET cv_summary_edited_at = now() WHERE id = $1', [id]);
    const again = await bot(['summary', id, '--feedback=--less formal'], {
      FAKE_CLAUDE_OUT: JSON.stringify({ summary: 'Laravel engineer.', note: 'Left out Go: the CV does not show it.' }),
      FAKE_CLAUDE_LOG: log,
    });
    assert.match(
      again,
      /CV summary : \(rewritten by AI with your feedback\)\nLaravel engineer\.\nNote {7}: Left out Go: the CV does not show it\./,
    );
    const [first, second] = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; stdin: string });
    assert.match(first.argv[first.argv.indexOf('--system-prompt') + 1], /CV, tailored to one job[\s\S]*Use ONLY facts in the CV/);
    assert.doesNotMatch(first.stdin, /FEEDBACK/);
    assert.match(second.stdin, /CURRENT SUMMARY:\nSenior Laravel engineer\.\n\nFEEDBACK FROM THE CANDIDATE:\n--less formal$/);
    j = await getJob(id);
    assert.deepEqual([j.cv_summary, j.cv_summary_edited_at], ['Laravel engineer.', null]);
  });

  it('headline writes a CV headline for the job, rewrites it with feedback, and cv:tailor puts it in a CV', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const env = { JOB_BOT_MASTER: path('cv', 'master.example.json') };
    const out = await bot(['headline', id], {
      ...env,
      FAKE_CLAUDE_OUT: JSON.stringify({ headline: 'Senior Full Stack Engineer · React & Node.js' }),
    });
    assert.match(out, /CV headline: \(written by AI for this job\)\nSenior Full Stack Engineer · React & Node\.js\n/);
    let j = await getJob(id);
    assert.equal(j.cv_headline, 'Senior Full Stack Engineer · React & Node.js');
    assert.ok(j.cv_headline_at instanceof Date);

    await pool.query('UPDATE jobs SET cv_headline_edited_at = now() WHERE id = $1', [id]);
    const again = await bot(['headline', id, '--feedback=shorter'], {
      ...env,
      FAKE_CLAUDE_OUT: JSON.stringify({ headline: 'Full Stack Engineer', note: '' }),
    });
    assert.match(again, /CV headline: \(rewritten by AI with your feedback\)\nFull Stack Engineer\n/);
    j = await getJob(id);
    assert.deepEqual([j.cv_headline, j.cv_headline_edited_at], ['Full Stack Engineer', null]);
  });

  it('headline keeps the current one when the AI names a skill the CV does not show, or fails', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await pool.query(`UPDATE jobs SET cv_headline = 'Kept' WHERE id = $1`, [id]);
    const env = { JOB_BOT_MASTER: path('cv', 'master.example.json') };
    for (const [extra, why] of [
      [
        { FAKE_CLAUDE_OUT: JSON.stringify({ headline: 'Senior Engineer · Kafka & React' }) },
        /The AI headline was not used, the headline is unchanged: it names Kafka, which your CV does not show/,
      ],
      [{ FAKE_CLAUDE_FAIL: 'offline' }, /AI headline failed, the headline is unchanged: .*offline/],
    ] as const) {
      await assert.rejects(bot(['headline', id], { ...env, ...extra }), (e: { stderr: string; code: number }) => {
        assert.match(e.stderr, why);
        assert.equal(e.code, 1);
        return true;
      });
    }
    assert.equal((await getJob(id)).cv_headline, 'Kept');
  });

  it('summary leaves the current summary alone when the AI fails', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await pool.query(`UPDATE jobs SET cv_summary = 'Kept.' WHERE id = $1`, [id]);
    await assert.rejects(bot(['summary', id], { FAKE_CLAUDE_FAIL: 'offline' }), (e: { stderr: string; code: number }) => {
      assert.match(e.stderr, /AI summary failed, the summary is unchanged: .*offline/);
      assert.equal(e.code, 1);
      return true;
    });
    assert.equal((await getJob(id)).cv_summary, 'Kept.');
    await expectNotFound(['summary', 'nope']);
  });

  it('cv:tailor refuses a job without a CV headline or summary', async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    await assert.rejects(bot(['cv:tailor', id]), (e: { stderr: string; code: number }) => {
      assert.match(e.stderr, /No CV headline or summary for this job yet: npm run bot -- headline \S+ \(or summary \S+\)/);
      assert.equal(e.code, 1);
      return true;
    });
    assert.equal((await getJob(id)).cv_version, null);
    await expectNotFound(['cv:tailor', 'nope']);
  });

  it('cv:tailor builds a CV with the job summary in a new folder every run and sets it as the job CV', {
    skip: !resolveChrome(JSON.parse(readFileSync(path('config.default.json'), 'utf8')).chromePath) && 'Chrome not installed',
  }, async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting({ company: 'Tailorco Cli' })])]));
    await pool.query(`UPDATE jobs SET cv_summary = 'Laravel engineer for Tailorco.' WHERE id = $1`, [id]);
    const made: string[] = [];
    try {
      for (let run = 0; run < 2; run++) {
        const out = await bot(['cv:tailor', id]);
        const version = out.match(/CV version : (\S+)/)![1];
        made.push(version);
        assert.match(version, /^custom-tailorco-cli-senior-laravel-developer-v\d+$/);
        const cv = JSON.parse(readFileSync(path('cv', 'versions', version, 'cv.json'), 'utf8'));
        assert.equal(cv.summary, 'Laravel engineer for Tailorco.');
        assert.equal(JSON.parse(readFileSync(path('cv', 'versions', version, 'meta.json'), 'utf8')).jobId, id);
        assert.equal(
          readFileSync(out.match(/CV file {4}: (\S+)/)![1])
            .subarray(0, 5)
            .toString(),
          '%PDF-',
        );
        assert.equal((await getJob(id)).cv_version, version);
      }
      assert.notEqual(made[0], made[1], 'a second run never overwrites the first CV');
      assert.equal(Number(made[1].split('-v').at(-1)), Number(made[0].split('-v').at(-1)) + 1);
    } finally {
      for (const v of made) rmSync(path('cv', 'versions', v), { recursive: true, force: true });
    }
  });

  it('custom --overrides still builds a one-off CV, in a new folder each run', {
    skip: !resolveChrome(JSON.parse(readFileSync(path('config.default.json'), 'utf8')).chromePath) && 'Chrome not installed',
  }, async () => {
    const id = idOf(await bot(['add', '--file', addFile([posting({ company: 'Customco Cli' })])]));
    const overrides = join(tmp, 'overrides.json');
    writeFileSync(overrides, JSON.stringify({ summary: 'Custom summary.' }));
    const made: string[] = [];
    try {
      for (let run = 0; run < 2; run++) {
        const file = (await bot(['custom', id, '--overrides', overrides])).match(/Custom CV: (\S+)/)![1];
        made.push(file.split('/').at(-2)!);
        assert.equal((await getJob(id)).cv_version, made.at(-1));
      }
      assert.match(made[0], /^custom-customco-cli-senior-laravel-developer-v\d+$/);
      assert.notEqual(made[0], made[1]);
    } finally {
      for (const v of made) rmSync(path('cv', 'versions', v), { recursive: true, force: true });
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
    // The next command changes nothing in the grouping, so it does not say it again.
    assert.doesNotMatch(await bot(['rescore']), /duplicate postings grouped/);
  });

  it('prints help for unknown commands', async () => {
    assert.match((await botExit(['nope'])).stdout, /Commands:[\s\S]*answer <id>/);
  });
});

// Exit code and output of a run that may fail.
const botExit = (args: string[], env: Record<string, string> = {}) =>
  bot(args, env).then(
    (stdout) => ({ code: 0, stdout, stderr: '' }),
    (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );

/** An unknown job id: "Not found" on stderr, nothing on stdout, exit code 1. */
async function expectNotFound(args: string[]) {
  const res = await botExit(args);
  assert.equal(res.code, 1, args.join(' '));
  assert.match(res.stderr, /^Not found$/m);
  assert.doesNotMatch(res.stdout, /Not found/);
}

/** The last stderr line (Node may first warn about a missing .env), and that no stack trace was printed. */
function oneLineError(res: { code: number; stderr: string }) {
  assert.equal(res.code, 1);
  const lines = res.stderr.trim().split('\n');
  assert.ok(!lines.some((l) => /^\s+at /.test(l)), res.stderr);
  return lines.at(-1);
}

describe('CLI user errors', () => {
  it('a missing DATABASE_URL is one line with no stack trace, and exit 1', async () => {
    const res = await botExit(['stats'], { DATABASE_URL: '' });
    assert.equal(oneLineError(res), 'DATABASE_URL is not set: put it in .env in the Talaash folder');
  });

  it('a ConfigError (an unreadable master CV) is one line with no stack trace, and exit 1', async () => {
    const res = await botExit(['add', '--file', addFile([posting({ url: 'https://example.com/jobs/config-error' })])], {
      JOB_BOT_MASTER: join(tmp, 'no-such-master.json'),
    });
    assert.match(oneLineError(res)!, /^Cannot read the master CV at .*no-such-master\.json/);
  });

  it('a command that needs a job id prints its usage line without one, and exit 1', async () => {
    for (const [cmd, line] of [
      ['show', 'show <id> [--full]'],
      ['cv:feedback', 'cv:feedback <id> --feedback "…"'],
      ['mark', 'mark <id> <status> [note]'],
      ['letter:pdf', 'letter:pdf <id>'],
    ]) {
      assert.equal(oneLineError(await botExit([cmd])), `Usage: npm run bot -- ${line}`);
    }
  });

  it('an unknown command says so and exits 1; no command just prints the help', async () => {
    const typo = await botExit(['fecth']);
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /^Unknown command: fecth$/m);
    assert.match(typo.stdout, /^Commands:/);
    assert.equal((await botExit([])).code, 0);
  });

  it('a missing or broken input file is one line, not a stack trace', async () => {
    assert.match(oneLineError(await botExit(['add', '--file', join(tmp, 'nope.json')]))!, /^Cannot read .*nope\.json: no such file$/);
    const broken = join(tmp, 'broken.json');
    writeFileSync(broken, '{ not json');
    assert.match(oneLineError(await botExit(['add', '--file', broken]))!, /broken\.json is not valid JSON/);
    assert.equal(oneLineError(await botExit(['custom', 'any:id'])), 'Usage: custom <id> --overrides f.json');
  });

  it('discover without names and list with an unknown status print their usage, and exit 1', async () => {
    assert.match(oneLineError(await botExit(['discover']))!, /^Usage: discover /);
    assert.match(oneLineError(await botExit(['list', '--status', 'bogus']))!, /^Usage: list \[--status new\|/);
  });
});

describe('CLI AI errors', () => {
  it('prints an AI setup problem as one line, with no stack trace, and exits 1', async () => {
    const d = mkdtempSync(join(tmp, 'ai-err-'));
    const config = join(d, 'config.json');
    const cfg = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
    writeFileSync(config, JSON.stringify({ ...cfg, ai: { ...cfg.ai, enabled: true, provider: 'api', api: { preset: 'deepseek' } } }));
    const id = idOf(await bot(['add', '--file', addFile([posting()])]));
    const res = await botExit(['answer', id, '--file', addFile([])], {
      JOB_BOT_CONFIG: config,
      AI_API_KEY: '',
      DEEPSEEK_API_KEY: '',
      OPENAI_API_KEY: '',
    });
    assert.equal(res.code, 1);
    // Without a .env (as in CI) Node first warns about it on stderr; the error is the last line, with no stack.
    const lines = res.stderr.trim().split('\n');
    assert.equal(
      lines.at(-1),
      'DeepSeek needs an API key: set AI_API_KEY in .env (in the Talaash folder), or set ai.provider to "claude-cli"',
    );
    assert.ok(!lines.some((l) => /^\s+at /.test(l)), res.stderr);
  });
});

describe('CLI settings', () => {
  // Never the worktree's own config.json / cv/applicant.json: JOB_BOT_CONFIG / JOB_BOT_APPLICANT point at temp copies.
  const realConfig = readFileSync(path('config.default.json'), 'utf8');
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
    // A command that never reads config.json still runs (the CLI checks the file up front only for the others).
    const contacts = await botExit(['contacts', 'no-such-job'], t.env);
    assert.equal(contacts.code, 1);
    assert.match(contacts.stderr, /^Not found: no-such-job$/m);
    assert.doesNotMatch(contacts.stderr, /Invalid settings/);
    const fixed = await botExit(['settings:save', '--kind', 'config', '--file', json(JSON.parse(realConfig))], t.env);
    assert.deepEqual(JSON.parse(fixed.stdout), { ok: true });
    assert.equal((await botExit(['list'], t.env)).code, 0);
  });

  it('an unknown stack id is refused by settings:check / settings:save and stops other commands', async () => {
    const t = target();
    const typo = { ...JSON.parse(realConfig), stacks: ['pyhton'] };
    const unknown = {
      path: 'stacks[0]',
      message: 'unknown stack "pyhton" (known: javascript, php-laravel, python; one per file in presets/stacks/)',
    };
    const check = await botExit(['settings:check', '--kind', 'config', '--file', json(typo)], t.env);
    assert.deepEqual([check.code, JSON.parse(check.stdout)], [1, { ok: false, errors: [unknown] }]);
    // Reported together with the schema's errors, so the Settings page shows every problem at once.
    const both = await botExit(['settings:check', '--kind', 'config', '--file', json({ ...badConfig(), stacks: ['pyhton'] })], t.env);
    assert.deepEqual(
      JSON.parse(both.stdout).errors.map((e: { path: string }) => e.path),
      ['maxAgeDays', 'stacks[0]'],
    );
    const refused = await botExit(['settings:save', '--kind', 'config', '--file', json(typo)], t.env);
    assert.deepEqual([refused.code, JSON.parse(refused.stdout)], [1, { ok: false, errors: [unknown] }]);
    assert.equal(readFileSync(t.config, 'utf8'), realConfig, 'config.json is left as it was');
    const empty = await botExit(['settings:save', '--kind', 'config', '--file', json({ ...typo, stacks: [] })], t.env);
    assert.deepEqual(JSON.parse(empty.stdout), { ok: true }, 'an empty list means the default stacks');

    writeFileSync(t.config, JSON.stringify(typo));
    const list = await botExit(['list'], t.env);
    assert.equal(list.code, 1);
    assert.ok(list.stderr.includes(`Invalid settings file ${t.config}:\n  - stacks[0]: unknown stack "pyhton"`), list.stderr);
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
    const cfg = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
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

  it('every AI feature works with only an API key: the Claude CLI is never run', async () => {
    const url = 'https://api.anthropic.com/v1/chat/completions';
    const env = (reply: object, log: string) => ({
      ...noKeys,
      AI_API_KEY: 'sk-ant-test-all-0123456789',
      JOB_BOT_CONFIG: withAi({ provider: 'api' }),
      FAKE_FETCH: JSON.stringify({ [url]: chat(reply) }),
      FAKE_FETCH_LOG: log,
      FAKE_CLAUDE_FAIL: 'the Claude CLI must not be used',
    });
    const id = idOf(await bot(['add', '--file', addFile([posting({ company: 'Apico Cli', url: 'https://example.com/jobs/api-all' })])]));
    const q = join(tmp, 'api-q.txt');
    writeFileSync(q, 'Notice period?');
    const prep = {
      technical: [{ question: 'How do you structure a large Laravel app?', hint: 'Modules and services.' }],
      behavioural: [{ question: 'A hard deadline?', situation: 'S', task: 'T', action: 'A', result: 'R' }],
      company: { brief: 'Builds software (from the posting).', verify: ['Team size'] },
      questions_to_ask: ['How are teams split?'],
      requirements: [{ requirement: 'Laravel', evidence: 'On the CV', gap: false }],
    };
    const steps: [string[], object, RegExp][] = [
      [['ai:score', '--id', id], review, /88 strong/],
      [['letter', id], { letter: 'Dear Apico Hiring Team,\nWritten through the API.' }, /\(written by AI from the job description\)/],
      [['headline', id], { headline: 'Senior Laravel Engineer · API' }, /Senior Laravel Engineer · API/],
      [['summary', id], { summary: 'Laravel engineer, summary from the API.' }, /summary from the API/],
      [
        ['answer', id, '--file', q],
        { answers: [{ question: 'Notice period?', answer: 'One month (API)', needs_input: false, note: '' }] },
        /A: One month \(API\)/,
      ],
      [['prep', id], prep, /with Anthropic claude-sonnet-5-5\.\.\.\n1 technical and 1 behavioural questions/],
      [['cv:review', id], { review: '- Lead with Laravel (API review).' }, /Lead with Laravel \(API review\)/],
    ];
    for (const [args, reply, expected] of steps) {
      const log = join(tmp, `api-all-${args[0].replace(':', '-')}.log`);
      const out = await bot(args, env(reply, log));
      assert.match(out, expected, args.join(' '));
      assert.ok(!out.includes('sk-ant-test'), `${args[0]} never prints the key`);
      assert.deepEqual([...new Set(readFileSync(log, 'utf8').trim().split('\n'))], [url], `${args[0]} asks only the API`);
    }
    // A follow-up is for an applied job.
    await bot(['mark', id, 'applied']);
    const log = join(tmp, 'api-all-follow-up.log');
    assert.match(await bot(['follow-up', id], env({ message: 'Dear Apico Hiring Team,\nStill keen (API).' }, log)), /Still keen \(API\)/);
    assert.deepEqual([...new Set(readFileSync(log, 'utf8').trim().split('\n'))], [url]);
    const j = (await getJob(id)) as unknown as Record<string, unknown>;
    assert.equal(j.ai_score, 88);
    assert.match(String(j.cover_letter), /Written through the API/);
    assert.equal(j.cv_review, '- Lead with Laravel (API review).');
    rmSync(applicationDirOf(j as unknown as { company: string; title: string }), { recursive: true, force: true });
  });

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
