import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { raw, TEST_DB } from './helpers.ts';
import { atsCheck, atsReport, foldText, versionCv } from '../src/ats.ts';
import { PROFILES } from '../src/cv/profiles.ts';
import { path } from '../src/config.ts';
import { migrate, pool } from '../src/db.ts';
import { save } from '../src/commands/shared.ts';
import type { Cv } from '../src/cv/render.ts';

const master = JSON.parse(readFileSync(path('cv', 'master.json'), 'utf8')) as Cv;
const check = (job: string, version: string) => atsCheck(job, master, versionCv(master, version), version);
const report = (job: string, version: string) => atsReport(job, master, versionCv(master, version), version);

// A small CV, so the fold is easy to reason about.
const tiny: Cv = {
  name: 'A',
  title: 'Engineer',
  contact: { phone: '', email: '', location: '', linkedin: '' },
  summary: 'Builds web apps.',
  skills: [
    { group: 'One', items: ['Laravel'] },
    { group: 'Two', items: ['React'] },
    { group: 'Three', items: ['MySQL'] },
    { group: 'Four', items: ['Docker'] },
  ],
  experience: [
    { role: 'Dev', company: 'X', location: '', dates: '', tags: [], bullets: ['Intro.', 'Did a.', 'Did b.', 'Ran GraphQL APIs.'] },
    { role: 'Dev', company: 'Y', location: '', dates: '', tags: [], bullets: ['Intro.'] },
    { role: 'Dev', company: 'Z', location: '', dates: '', tags: [], bullets: ['Used Redux.'] },
  ],
  projects: [],
  education: [],
};

describe('atsCheck', () => {
  it('splits job keywords into shown, hidden-but-true and missing', () => {
    const job = 'We need Laravel, React, MySQL, Docker, GraphQL, Redux and Kubernetes.';
    assert.deepEqual(atsCheck(job, tiny, tiny, 'default'), {
      version: 'default',
      present: ['Laravel', 'React', 'MySQL'],
      // Fourth skill group, fourth bullet of the first role, third role: all below the fold.
      hiddenButTrue: ['Redux', 'GraphQL', 'Docker'],
      missing: ['Kubernetes'],
    });
  });

  it('only looks at keywords the job asks for', () => {
    assert.deepEqual(atsCheck('Laravel only', tiny, tiny, 'default'), {
      version: 'default',
      present: ['Laravel'],
      hiddenButTrue: [],
      missing: [],
    });
  });

  it('a cluster version moves its own skills above the fold', () => {
    const job = 'Senior engineer: OpenAI GPT, LLM agents, AWS and Docker.';
    const def = check(job, 'default');
    const ai = check(job, 'ai-fullstack');
    assert.ok(ai.present.includes('LLM / AI'));
    assert.ok(foldText(versionCv(master, 'ai-fullstack')).includes('OpenAI GPT APIs'));
    assert.deepEqual(def.missing, ai.missing);
  });

  it('missing keywords are exactly the ones not on master.json, whichever version is checked', () => {
    const job = 'Python, Kubernetes, Angular, Redis, Kafka, Terraform, Laravel and React.';
    for (const v of ['default', ...Object.keys(PROFILES)]) {
      assert.deepEqual(check(job, v).missing, ['Angular', 'Kubernetes', 'Redis', 'Kafka', 'Terraform', 'Python'], v);
    }
  });
});

describe('atsReport', () => {
  const job = 'NestJS, Next.js, TypeScript, MongoDB, Prisma, TypeORM, GraphQL, Jest testing, Kubernetes and Kafka.';

  it('suggests the cluster version that shows the most job keywords, with what it adds', () => {
    const r = report(job, 'laravel');
    assert.ok(r.suggestion);
    const best = check(job, r.suggestion.version);
    assert.equal(r.suggestion.shows, best.present.length);
    assert.ok(r.suggestion.shows > r.present.length);
    for (const v of ['default', ...Object.keys(PROFILES)]) assert.ok(check(job, v).present.length <= r.suggestion.shows, v);
    assert.deepEqual(
      r.suggestion.gains,
      best.present.filter((k) => !r.present.includes(k)),
    );
    assert.equal(r.total, r.present.length + r.hiddenButTrue.length + r.missing.length);
  });

  it('no suggestion when the checked version is already the best', () => {
    const first = report(job, 'laravel').suggestion!.version;
    assert.equal(report(job, first).suggestion, null);
  });

  it('never suggests a missing keyword, for any version and job', () => {
    const jobs = [
      job,
      'Laravel, Vue, Docker, AWS, Redis, Microservices, Go',
      'React, Angular, Azure, GCP, Java, C#/.NET, Ruby on Rails',
      'LLM, OpenAI, Python, FastAPI, Kubernetes, Terraform, CI/CD, PostgreSQL',
    ];
    for (const text of jobs) {
      for (const v of ['default', ...Object.keys(PROFILES)]) {
        const r = report(text, v);
        const suggested = [...r.present, ...r.hiddenButTrue, ...(r.suggestion?.gains ?? [])];
        for (const m of r.missing) assert.ok(!suggested.includes(m), `${m} suggested for ${v}`);
      }
    }
  });
});

describe('ats CLI', () => {
  const run = promisify(execFile);
  const bot = async (args: string[]) =>
    (
      await run(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], {
        cwd: path(),
        env: { ...process.env, DATABASE_URL: TEST_DB },
        timeout: 60_000,
      })
    ).stdout;

  before(migrate);
  beforeEach(() => pool.query('TRUNCATE jobs, job_events, fetch_runs CASCADE'));
  after(() => pool.end());

  it('prints the three lists and a suggestion for the suggested version', async () => {
    await save(
      raw({ id: 'test:ats', description: 'NestJS, Next.js, TypeScript, MongoDB, Prisma, GraphQL, React, Node.js and Kubernetes.' }),
    );
    const out = await bot(['ats', 'test:ats', '--cv', 'laravel']);
    assert.match(out, /CV keyword check — Acme — Senior Full Stack Engineer/);
    assert.match(out, /CV version {5}: laravel \(chosen with --cv\), shows \d+ of 9 job keywords/);
    assert.match(out, /Missing {8}: Kubernetes {3}\(real gaps/);
    assert.match(out, /Suggestion {5}: the "[a-z-]+" version shows \d+ \(\+ .+\) — prepare test:ats --cv [a-z-]+/);
  });

  it("--json returns the report for the job's suggested cluster", async () => {
    await save(raw({ id: 'test:ats', description: 'Laravel, PHP, MySQL and Kafka.' }));
    const { cluster } = (await pool.query<{ cluster: string }>(`SELECT cluster FROM jobs WHERE id = 'test:ats'`)).rows[0];
    const r = JSON.parse(await bot(['ats', 'test:ats', '--json']));
    assert.equal(r.label, cluster);
    assert.equal(r.source, 'suggested');
    assert.deepEqual(r.missing, ['Kafka']);
    assert.ok(r.present.includes('Laravel'));
  });

  it('says so when the job does not exist', async () => {
    assert.match(await bot(['ats', 'nope']), /Not found/);
  });
});
