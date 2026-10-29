import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.ts';
import { config } from '../src/config.ts';
import { PROFILES } from '../src/cv/profiles.ts';
import { cvHtml, renderPdf, type Cv } from '../src/cv/render.ts';
import { applyProfile, cvFile, masterHash, masterRaw } from '../src/cv/versions.ts';
import { coverLetter } from '../src/cover.ts';
import type { Job } from '../src/db.ts';

const master = JSON.parse(masterRaw()) as Cv;
const allSkills = (cv: Cv) => cv.skills.flatMap((g) => g.items).sort();

describe('CV versions', () => {
  it('every version keeps the same PDF file name, only the folder differs', () => {
    assert.equal(config.cvFileName, 'abdulrehman_dar_resume.pdf');
    assert.ok(cvFile('default').endsWith('/cv/default/abdulrehman_dar_resume.pdf'));
    assert.ok(cvFile('laravel-v2').endsWith('/cv/versions/laravel-v2/abdulrehman_dar_resume.pdf'));
  });

  for (const [id, p] of Object.entries(PROFILES)) {
    it(`profile "${id}" only re-orders the CV, never adds skills, jobs or bullets`, () => {
      const cv = applyProfile(master, p);
      assert.deepEqual(allSkills(cv), allSkills(master));
      assert.deepEqual(cv.experience.map((e) => e.company), master.experience.map((e) => e.company));
      cv.experience.forEach((e, i) => {
        assert.deepEqual([...e.bullets].sort(), [...master.experience[i].bullets].sort());
        assert.equal(e.bullets[0], master.experience[i].bullets[0], 'first bullet introduces the role and stays first');
      });
      assert.deepEqual(cv.projects.map((x) => x.name).sort(), master.projects.map((x) => x.name).sort());
      assert.deepEqual(cv.contact, master.contact);
    });
  }

  it('profiles move their key skills to the front', () => {
    const cv = applyProfile(master, PROFILES.laravel);
    assert.equal(cv.skills[0].group, PROFILES.laravel.groupsFirst[0]);
    assert.equal(cv.title, PROFILES.laravel.title);
  });

  it('the CV lists Tailwind but not Angular', () => {
    assert.ok(allSkills(master).includes('Tailwind CSS'));
    assert.ok(!allSkills(master).some((s) => /angular/i.test(s)));
  });

  it('masterHash is stable and short', () => {
    assert.equal(masterHash(), masterHash());
    assert.match(masterHash(), /^[0-9a-f]{12}$/);
  });
});

describe('CV template', () => {
  it('renders every section as real text and escapes HTML', () => {
    const html = cvHtml({ ...master, summary: 'Uses <script> & more' });
    assert.match(html, /Uses &lt;script&gt; &amp; more/);
    for (const section of ['Experience', 'Skills', 'Education']) assert.match(html, new RegExp(section, 'i'));
    assert.match(html, new RegExp(master.contact.email));
    assert.match(html, /@page \{ size: A4/);
  });

  it('renders a PDF with Chrome', { skip: !existsSync(process.env.JOB_BOT_CHROME || config.chromePath) && 'Chrome not installed', timeout: 60_000 }, async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'jobbot-cv-')), config.cvFileName);
    await renderPdf(master, out);
    assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
    assert.ok(statSync(out).size > 10_000);
  });
});

describe('template cover letter', () => {
  const job = (o: Partial<Job>) => ({ company: 'Acme', title: 'Laravel Developer', country: 'AE', matched: ['Laravel', 'PHP'],
    cluster: 'laravel', ...o }) as Job;

  it('addresses the company and role and signs off', () => {
    const l = coverLetter(job({}));
    assert.match(l, /^Dear Acme Hiring Team,/);
    assert.match(l, /the Laravel Developer role/);
    assert.match(l, /Laravel, PHP/);
    assert.match(l, /Best regards,\nAbdul Rehman Dar/);
  });

  it('asks for sponsorship for onsite jobs and mentions Pakistan for remote ones', () => {
    assert.match(coverLetter(job({})), /relocate to UAE\. I would need employer visa sponsorship/);
    const remote = coverLetter(job({ country: 'RM' }));
    assert.match(remote, /Lahore, Pakistan \(GMT\+5\)/);
    assert.doesNotMatch(remote, /sponsorship/);
  });

  it('falls back to the default pitch for unknown clusters', () => {
    assert.match(coverLetter(job({ cluster: 'nope' })), /both the JavaScript stack/);
  });
});
