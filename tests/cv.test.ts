import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChrome } from '../src/cv/chrome.ts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.ts';
import { config, path } from '../src/config.ts';
import { PROFILES } from '../src/cv/profiles.ts';
import { cvHtml, htmlToPdf, letterHtml, renderPdf, type Cv } from '../src/cv/render.ts';
import { applyProfile, claimCustomId, cvFile, masterHash, masterRaw } from '../src/cv/versions.ts';
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
      assert.deepEqual(
        cv.experience.map((e) => e.company),
        master.experience.map((e) => e.company),
      );
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

  it('renders a PDF with Chrome', {
    skip: !resolveChrome(config.chromePath) && 'Chrome not installed',
    timeout: 60_000,
  }, async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'jobbot-cv-')), config.cvFileName);
    await renderPdf(master, out);
    assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
    assert.ok(statSync(out).size > 10_000);
  });
});

describe('template cover letter', () => {
  const job = (o: Partial<Job>) =>
    ({ company: 'Acme', title: 'Laravel Developer', country: 'AE', matched: ['Laravel', 'PHP'], cluster: 'laravel', ...o }) as Job;

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

describe('cover letter PDF', () => {
  const cv = {
    name: 'Jane <Doe>',
    title: 'Senior Engineer',
    contact: { phone: '+1 555', email: 'jane@example.com', location: 'Lisbon, Portugal', linkedin: 'https://linkedin.com/in/jane' },
  };
  const letter = 'Dear Acme Hiring Team,\n\nI build <APIs> & ship.\nSecond line.\n\nBest regards,\nJane Doe\n';

  it('has the CV header, the date and one paragraph per block, escaped', () => {
    const html = letterHtml(cv, letter, new Date('2026-10-30T12:00:00Z'));
    assert.match(html, /<h1>Jane &lt;Doe&gt;<\/h1>/);
    assert.match(html, /<div class="title">Senior Engineer<\/div>/);
    assert.match(
      html,
      /\+1 555 \| <a href="mailto:jane@example.com">jane@example.com<\/a> \| Lisbon, Portugal \| <a href="https:\/\/linkedin.com\/in\/jane">LinkedIn<\/a>/,
    );
    assert.match(html, /<div class="date">30 October 2026<\/div>/);
    assert.match(
      html,
      /<p>Dear Acme Hiring Team,<\/p>\n<p>I build &lt;APIs&gt; &amp; ship\.<br>Second line\.<\/p>\n<p>Best regards,<br>Jane Doe<\/p>/,
    );
  });

  it('leaves out empty contact fields', () => {
    const html = letterHtml({ ...cv, contact: { phone: '', email: 'jane@example.com', location: '', linkedin: '' } }, letter);
    assert.match(html, /<div class="contact"><a href="mailto:jane@example.com">jane@example.com<\/a><\/div>/);
  });

  it('prints a PDF with Chrome', {
    skip: !resolveChrome(config.chromePath) && 'Chrome not installed',
    timeout: 60_000,
  }, async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'jobbot-letter-')), 'cover-letter.pdf');
    await htmlToPdf(letterHtml(cv, letter), out);
    assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
  });
});

describe('one-off CV versions for a job', () => {
  it('get a new, never reused folder every time: custom-<slug>-v<N>', () => {
    const slug = `unique-test-${process.pid}`;
    const ours = () => readdirSync(path('cv', 'versions')).filter((d) => d.startsWith(`custom-${slug}`));
    try {
      assert.equal(claimCustomId(slug), `custom-${slug}-v1`);
      assert.equal(claimCustomId(slug), `custom-${slug}-v2`);
      assert.ok(existsSync(path('cv', 'versions', `custom-${slug}-v2`)), 'the folder is claimed at once');
      // A gap or an old unnumbered folder never makes it reuse a number.
      rmSync(path('cv', 'versions', `custom-${slug}-v1`), { recursive: true });
      assert.equal(claimCustomId(slug), `custom-${slug}-v3`);
      // Another slug that only starts the same is not counted.
      mkdirSync(path('cv', 'versions', `custom-${slug}-vx-v9`));
      assert.equal(claimCustomId(slug), `custom-${slug}-v4`);
      assert.deepEqual(ours().sort(), [`custom-${slug}-v2`, `custom-${slug}-v3`, `custom-${slug}-v4`, `custom-${slug}-vx-v9`]);
    } finally {
      for (const d of ours()) rmSync(path('cv', 'versions', d), { recursive: true, force: true });
    }
  });

  it('an old unnumbered custom-<slug> folder counts as v1', () => {
    const slug = `legacy-test-${process.pid}`;
    try {
      mkdirSync(path('cv', 'versions', `custom-${slug}`), { recursive: true });
      assert.equal(claimCustomId(slug), `custom-${slug}-v2`);
    } finally {
      for (const d of [`custom-${slug}`, `custom-${slug}-v2`]) rmSync(path('cv', 'versions', d), { recursive: true, force: true });
    }
  });
});
