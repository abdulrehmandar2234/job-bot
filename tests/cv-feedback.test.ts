import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './helpers.ts';
import { path } from '../src/config.ts';
import { type CvProposal, keepToMaster, normalize, unsupportedClaims } from '../src/cv/feedback.ts';
import type { Cv } from '../src/cv/render.ts';

// The check behind "Improve CV with feedback": the AI's revised CV keeps only what cv/master.json has.
const master = JSON.parse(readFileSync(path('cv', 'master.example.json'), 'utf8')) as Cv;
const [travel, agency] = master.experience;

/** The master CV as a proposal: what an AI that changes nothing would return. */
const same = (): CvProposal => ({
  title: master.title,
  summary: master.summary,
  skills: master.skills.map((g) => ({ group: g.group, items: [...g.items] })),
  experience: master.experience.map((e) => ({ company: e.company, role: e.role, bullets: [...e.bullets] })),
  projects: master.projects.map((p) => p.name),
});

describe('keepToMaster', () => {
  it('keeps an unchanged CV as it is, with nothing removed', () => {
    assert.deepEqual(keepToMaster(same(), master, master), { cv: master, removed: [] });
  });

  it('allows reordering and selecting skills, bullets and projects, and a new title and summary from master facts', () => {
    const p = same();
    p.title = 'Senior React Engineer';
    p.summary = 'React and Next.js engineer with 5 years of experience; took a booking platform to 50,000 monthly users.';
    p.skills = [
      { group: 'Frameworks & Libraries', items: ['Next.js', 'React.js'] },
      { group: 'languages & runtimes', items: ['typescript'] }, // case and spacing do not matter
    ];
    p.experience = [
      {
        company: 'Example Travel',
        role: 'Full Stack Engineer',
        bullets: [travel.bullets[1], `  ${travel.bullets[0].replace(/\.$/, '')}  `],
      },
      { company: 'Sample Agency', role: 'Front-end Developer', bullets: [agency.bullets[0]] },
    ];
    p.projects = [];
    const { cv, removed } = keepToMaster(p, master, master);
    assert.deepEqual(removed, []);
    assert.equal(cv.title, 'Senior React Engineer');
    assert.match(cv.summary, /^React and Next\.js engineer/);
    assert.deepEqual(cv.skills, [
      { group: 'Frameworks & Libraries', items: ['Next.js', 'React.js'] },
      { group: 'Languages & Runtimes', items: ['TypeScript'] },
    ]);
    assert.deepEqual(cv.experience[0].bullets, [travel.bullets[1], travel.bullets[0]], 'the master wording is kept');
    assert.deepEqual(cv.experience[1].bullets, [agency.bullets[0]]);
    assert.deepEqual(cv.projects, []);
    assert.deepEqual([cv.name, cv.contact, cv.education], [master.name, master.contact, master.education]);
  });

  it('strips an invented skill, skill group, employer, bullet and project, and names each one', () => {
    const p = same();
    p.skills[0].items.push('Kubernetes');
    p.skills.push({ group: 'Cloud', items: ['AWS'] });
    p.experience.unshift({ company: 'Google', role: 'Staff Engineer', bullets: ['Led search.'] });
    p.experience[1].bullets.push('Cut costs by 90%.');
    p.projects.push('Secret App');
    const { cv, removed } = keepToMaster(p, master, master);
    assert.deepEqual(cv, master);
    assert.deepEqual(removed, [
      'Skill "Kubernetes" (not on your master CV)',
      'Skill group "Cloud" (not on your master CV)',
      'Employer "Google" (not on your master CV)',
      'Bullet "Cut costs by 90%." under Example Travel (not on your master CV for that job)',
      'Project "Secret App" (not on your master CV)',
    ]);
  });

  it('keeps the current title or summary when the new one names a skill or number the master does not have', () => {
    const current = { ...master, summary: 'The current summary.', title: 'Current title' };
    const p = same();
    p.title = 'Kubernetes Engineer';
    p.summary = 'Engineer with 9 years of Angular and React.';
    const { cv, removed } = keepToMaster(p, master, current);
    assert.equal(cv.title, 'Current title');
    assert.equal(cv.summary, 'The current summary.');
    assert.deepEqual(removed, [
      'The new title, because it names Kubernetes, which your master CV does not show (kept the current title)',
      'The new summary, because it names Angular, 9, which your master CV does not show (kept the current summary)',
    ]);
  });

  it('never drops an employer: one the AI left out comes back at the end, with its current bullets', () => {
    const current = { ...master, experience: [travel, { ...agency, bullets: [agency.bullets[1]] }] };
    const p = same();
    p.experience = [p.experience[0]];
    const { cv, removed } = keepToMaster(p, master, current);
    assert.deepEqual(
      cv.experience.map((e) => [e.company, e.bullets]),
      [
        ['Example Travel', travel.bullets],
        ['Sample Agency', [agency.bullets[1]]],
      ],
    );
    assert.deepEqual(removed, ['Dropping Sample Agency from the work experience (employers always stay on the CV, so it was kept)']);
  });

  it('a job left with no master bullets keeps its current ones; empty title, summary or skills keep the current', () => {
    const p: Partial<CvProposal> = {
      title: ' ',
      experience: [
        { company: 'Example Travel', role: 'Full Stack Engineer', bullets: ['Invented.'] },
        { company: 'Sample Agency', role: 'Front-end Developer', bullets: [] },
      ],
    };
    const { cv } = keepToMaster(p, master, master);
    assert.deepEqual([cv.title, cv.summary, cv.skills], [master.title, master.summary, master.skills]);
    assert.deepEqual(
      cv.experience.map((e) => e.bullets),
      [travel.bullets, agency.bullets],
    );
    assert.deepEqual(cv.projects, [], 'no projects listed means none shown');
  });

  it('drops duplicates the AI repeats', () => {
    const p = same();
    p.skills = [
      { group: 'APIs & Web', items: ['GraphQL', 'GraphQL', 'REST APIs'] },
      { group: 'APIs & Web', items: ['REST APIs'] },
    ];
    p.projects = ['Trip Planner', 'trip planner'];
    const { cv, removed } = keepToMaster(p, master, master);
    assert.deepEqual(cv.skills, [{ group: 'APIs & Web', items: ['GraphQL', 'REST APIs'] }]);
    assert.equal(cv.projects.length, 1);
    assert.deepEqual(removed, []);
  });
});

describe('unsupportedClaims and normalize', () => {
  it('names known skills and numbers that the master CV never mentions', () => {
    assert.deepEqual(unsupportedClaims('React engineer, 5 years, 50,000 users', master), []);
    assert.deepEqual(unsupportedClaims('Python and Kafka for 12 years', master), ['Kafka', 'Python', '12']);
  });

  it('ignores case, quotes, dashes, spacing and trailing punctuation', () => {
    assert.equal(normalize('  Built   the “API” – fast. '), normalize('built the "api" - fast'));
  });
});
