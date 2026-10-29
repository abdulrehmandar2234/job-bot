import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { daysAgo, raw } from './helpers.ts';
import { pickCluster, scoreJob } from '../src/match.ts';

describe('scoreJob: location', () => {
  it('matches onsite jobs in the target countries', () => {
    assert.equal(scoreJob(raw({ location: 'Dubai, UAE' })).country, 'AE');
    assert.equal(scoreJob(raw({ location: 'Riyadh, Saudi Arabia' })).country, 'SA');
  });

  it('filters locations outside the target countries', () => {
    const s = scoreJob(raw({ location: 'Berlin, Germany' }));
    assert.equal(s.country, null);
    assert.match(s.filterReason!, /location not in target countries/);
  });

  it('finds the country in the description for remote EMEA roles', () => {
    const s = scoreJob(raw({ location: 'Europe', description: `${raw().description} Our office is based in Amsterdam.` }));
    assert.equal(s.country, 'NL');
  });
});

describe('scoreJob: remote from Pakistan', () => {
  it('accepts worldwide remote jobs as RM without a visa check', () => {
    const s = scoreJob(raw({ location: 'Remote — Worldwide', description: `${raw().description} We do not sponsor visas.` }));
    assert.equal(s.country, 'RM');
    assert.equal(s.filterReason, null);
    assert.equal(s.visa, 'Remote: work from Pakistan, no visa needed');
  });

  it('rejects remote jobs limited to other regions', () => {
    const s = scoreJob(raw({ location: 'Remote — USA, Canada' }));
    assert.equal(s.country, null);
    assert.match(s.filterReason!, /remote, but only for/);
  });

  it('rejects remote regions that do not include Pakistan', () => {
    assert.match(scoreJob(raw({ location: 'Remote — Kenya' })).filterReason!, /does not include Pakistan/);
  });

  it('rejects remote jobs whose description requires living elsewhere', () => {
    const s = scoreJob(raw({ location: 'Remote', description: `${raw().description} Candidates must reside in the United States.` }));
    assert.match(s.filterReason!, /remote, but:/);
  });

  it('treats "Remote — Dubai" as an onsite UAE job', () => {
    assert.equal(scoreJob(raw({ location: 'Remote — Dubai' })).country, 'AE');
  });

  it('flags EMEA / unstated regions for a manual check', () => {
    const s = scoreJob(raw({ location: 'Remote — EMEA' }));
    assert.equal(s.country, 'RM');
    assert.ok(s.flags.some((f) => /confirm Pakistan/.test(f)));
  });
});

describe('scoreJob: title, age and language', () => {
  it('filters non-engineering titles', () => {
    assert.equal(scoreJob(raw({ title: 'Account Executive' })).filterReason, 'title is not an engineering role');
  });

  it('filters excluded stacks and roles', () => {
    for (const title of ['Senior Java Developer', 'React Native Engineer', 'Software Engineering Intern', 'WordPress Developer']) {
      assert.match(scoreJob(raw({ title })).filterReason!, /title excluded/, title);
    }
  });

  it('filters postings older than maxAgeDays', () => {
    assert.match(scoreJob(raw({ posted_at: daysAgo(30) })).filterReason!, /posted 30 days ago/);
  });

  it('flags an unknown posting date instead of filtering', () => {
    const s = scoreJob(raw({ posted_at: null }));
    assert.equal(s.filterReason, null);
    assert.ok(s.flags.includes('posting date unknown'));
  });

  it('filters jobs that require Arabic or Dutch', () => {
    const s = scoreJob(raw({ description: `${raw().description} Fluent Arabic is required.` }));
    assert.match(s.filterReason!, /language required/);
  });

  it('only flags a language that is a plus', () => {
    const s = scoreJob(raw({ description: `${raw().description} Arabic is a plus.` }));
    assert.equal(s.filterReason, null);
    assert.ok(s.flags.includes('local language is a plus'));
  });
});

describe('scoreJob: visa', () => {
  it('gives employer visa for UAE and Saudi', () => {
    assert.equal(scoreJob(raw()).visa, 'UAE: employer issues work visa');
  });

  it('filters onsite jobs that say no sponsorship', () => {
    const s = scoreJob(raw({ description: `${raw().description} We are unable to offer visa sponsorship.` }));
    assert.match(s.filterReason!, /no visa sponsorship/);
  });

  it('filters NL jobs at companies not on the IND sponsor register', () => {
    const s = scoreJob(raw({ company: 'Totally Unknown Startup Xyz', location: 'Amsterdam, Netherlands' }));
    assert.equal(s.filterReason, 'NL job but company not on IND sponsor register');
  });

  it('accepts NL jobs that mention visa sponsorship', () => {
    const s = scoreJob(raw({ company: 'Totally Unknown Startup Xyz', location: 'Amsterdam',
      description: `${raw().description} We offer visa sponsorship and relocation support.` }));
    assert.equal(s.filterReason, null);
    assert.match(s.visa!, /visa\/relocation support/);
  });
});

describe('scoreJob: skills and score', () => {
  it('scores the share of weighted skills the CV has', () => {
    const s = scoreJob(raw());
    assert.equal(s.filterReason, null);
    assert.ok(s.matched.includes('Laravel') && s.matched.includes('React'));
    assert.deepEqual(s.missing, []);
    assert.equal(s.score, 100);
  });

  it('lists skills the CV lacks and lowers the score', () => {
    const s = scoreJob(raw({ description: 'Node.js, TypeScript, React, Kubernetes, Kafka, Redis, Angular and Python' }));
    assert.ok(s.missing.includes('Angular') && s.missing.includes('Kubernetes'));
    assert.ok(s.score < 100);
  });

  it('never counts Angular as a skill the candidate has, but does count Tailwind', () => {
    const s = scoreJob(raw({ description: 'React, Node.js, TypeScript, Tailwind CSS and Angular' }));
    assert.ok(s.missing.includes('Angular'));
    assert.ok(s.matched.includes('Tailwind CSS'));
  });

  it('caps the score when only 1-2 skills match', () => {
    assert.equal(scoreJob(raw({ title: 'Laravel Developer', description: 'Laravel' })).score, 50);
  });

  it('filters postings with no recognisable stack', () => {
    assert.equal(scoreJob(raw({ description: 'Great culture, free snacks.' })).filterReason, 'no recognisable tech stack in posting');
  });

  it('penalises junior roles and very long experience requirements', () => {
    const junior = scoreJob(raw({ title: 'Junior Web Developer' }));
    assert.ok(junior.flags.includes('junior role'));
    const veteran = scoreJob(raw({ description: `${raw().description} 12+ years of experience.` }));
    assert.ok(veteran.flags.includes('asks 12+ years'));
  });

  it('filters scores below minScore', () => {
    const s = scoreJob(raw({ title: 'Junior Developer', description: 'Python, Java, Go, Ruby, PHP' }));
    assert.match(s.filterReason!, /below minScore/);
  });
});

describe('pickCluster', () => {
  it('keeps the default CV for Laravel + JS postings', () => {
    assert.equal(pickCluster('Laravel and React'), 'default');
  });
  it('picks the AI cluster for JS + LLM work', () => {
    assert.equal(pickCluster('Node.js engineer building LLM features with OpenAI'), 'ai-fullstack');
  });
  it('picks the most specific cluster', () => {
    assert.equal(pickCluster('Laravel, Livewire and Tailwind'), 'tall');
    assert.equal(pickCluster('Laravel with Vue.js'), 'laravel-vue');
    assert.equal(pickCluster('NestJS and Next.js'), 'next-nest');
    assert.equal(pickCluster('MongoDB, Express, React, Node'), 'mern');
    assert.equal(pickCluster('PostgreSQL, React and Node'), 'pern');
    assert.equal(pickCluster('PHP developer'), 'laravel');
    assert.equal(pickCluster('React and Next.js'), 'frontend-react');
  });
  it('falls back to default', () => {
    assert.equal(pickCluster('COBOL'), 'default');
  });
});
