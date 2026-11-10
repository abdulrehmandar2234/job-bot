import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysAgo, raw } from './helpers.ts'; // first: it points the bot at a temp config before src/ loads one
import { isIndSponsor } from '../src/sponsors.ts';
import { languageRules, pickCluster, scoreJob, SKILLS, titleOk } from '../src/match.ts';
import { config } from '../src/config.ts';
import { ConfigError } from '../src/errors.ts';

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

describe('titleOk', () => {
  const titles = [
    'Senior Backend Engineer',
    'Laravel Developer',
    'Full-Stack Developer',
    'Sales Manager',
    'iOS Engineer',
    'Senior Python Engineer',
    'React Native Developer',
    'Head of Engineering',
    'Office Assistant',
    'WEB DEVELOPER',
  ];
  // The filter the sources used to compile inline (linkedin.ts, the SmartRecruiters / Workday prefilter).
  const inline = (cfg: { roleInclude: string; roleExclude: string }) => {
    const include = new RegExp(cfg.roleInclude, 'i');
    const exclude = new RegExp(cfg.roleExclude, 'i');
    return (t: string) => include.test(t) && !exclude.test(t);
  };

  it('matches the previous inline filter and the title checks of scoreJob', () => {
    const ok = titleOk(config);
    const old = inline(config);
    for (const t of titles) {
      assert.equal(ok(t), old(t), t);
      assert.equal(!/^title /.test(scoreJob(raw({ title: t })).filterReason ?? ''), ok(t), t);
    }
    assert.deepEqual(titles.filter(ok), ['Senior Backend Engineer', 'Laravel Developer', 'Full-Stack Developer', 'WEB DEVELOPER']);
  });

  it('uses the settings it is given, and gives the same answer on every call', () => {
    const cfg = { roleInclude: 'assistant', roleExclude: 'office' };
    const ok = titleOk(cfg);
    for (const t of [...titles, 'Executive Assistant']) {
      assert.equal(ok(t), inline(cfg)(t), t);
      assert.equal(ok(t), ok(t), t); // no global-flag lastIndex state
    }
    assert.equal(ok('Executive Assistant'), true);
  });
});

describe('scoreJob: settings passed in', () => {
  it('uses the settings it is given instead of config.json, and leaves config.json alone', () => {
    const cfg = {
      ...config,
      countries: { DE: { name: 'Germany', visa: 'employer' as const, match: 'berlin|germany', needsVisa: false } },
      remote: { ...config.remote, enabled: false },
    };
    const berlin = raw({ location: 'Berlin, Germany' });
    const s = scoreJob(berlin, cfg);
    assert.equal(s.country, 'DE');
    assert.equal(s.visa, 'Germany: no visa needed');
    assert.equal(scoreJob(raw({ location: 'Dubai, UAE' }), cfg).country, null);
    assert.equal(scoreJob(raw({ location: 'Remote — Worldwide' }), cfg).country, null); // remote search is off here
    assert.equal(scoreJob(berlin).country, null); // the default is still config.json
    assert.match(scoreJob(berlin, { ...cfg, minScore: 101 }).filterReason!, /below minScore 101/);
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
    assert.match(scoreJob(raw({ location: 'Remote — Japan' })).filterReason!, /does not include Pakistan/);
    assert.match(scoreJob(raw({ location: 'Remote — Kenya' })).filterReason!, /remote, but only for: Kenya/);
  });

  it('accepts regions Pakistan is in, and rejects India-only remote jobs', () => {
    for (const where of ['Remote — South Asia', 'Remote (APAC)', 'Remote, GMT+5', 'Remote — Middle East'])
      assert.equal(scoreJob(raw({ location: where })).country, 'RM', where);
    assert.match(scoreJob(raw({ location: 'Remote — India' })).filterReason!, /remote, but only for: India/);
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
    const titles = ['Senior Java Developer', 'React Native Engineer', 'Software Engineering Intern', 'WordPress Developer'];
    for (const title of [...titles, 'SQA Engineer - Automation (Remote - Night Shift | Pakistan)', 'QA Engineer', 'Senior SQA Engineer']) {
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
  it('says plainly when a UAE or Saudi posting does not mention visa or relocation ("silent")', () => {
    const s = scoreJob(raw());
    assert.equal(s.visa, 'UAE: posting does not mention visa or relocation (employers there usually sponsor the work visa)');
    assert.equal(s.visaEvidence, 'silent');
    assert.equal(s.filterReason, null); // labelled, not hidden
  });

  it('"offered" only when the posting itself mentions visa or relocation support', () => {
    const s = scoreJob(raw({ description: `${raw().description} We provide visa sponsorship and a relocation package.` }));
    assert.equal(s.visa, 'UAE: posting offers visa/relocation support');
    assert.equal(s.visaEvidence, 'offered');
  });

  it('"not-needed" for remote jobs', () => {
    const s = scoreJob(raw({ location: 'Remote — Worldwide' }));
    assert.equal(s.visaEvidence, 'not-needed');
  });

  it('no evidence on a filtered job', () => {
    const s = scoreJob(raw({ description: `${raw().description} We are unable to offer visa sponsorship.` }));
    assert.equal(s.visaEvidence, null);
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
    const s = scoreJob(
      raw({
        company: 'Totally Unknown Startup Xyz',
        location: 'Amsterdam',
        description: `${raw().description} We offer visa sponsorship and relocation support.`,
      }),
    );
    assert.equal(s.filterReason, null);
    assert.match(s.visa!, /visa\/relocation support/);
    assert.equal(s.visaEvidence, 'offered');
  });

  it('an IND recognised sponsor whose posting is silent is "can-sponsor", not "offered"', (t) => {
    if (isIndSponsor('Adyen') === null) return t.skip('IND register not downloaded');
    const s = scoreJob(raw({ company: 'Adyen', location: 'Amsterdam, Netherlands' }));
    assert.equal(s.filterReason, null);
    assert.equal(s.visaEvidence, 'can-sponsor');
    assert.equal(s.visa, 'Netherlands: company is an IND recognised sponsor, but the posting does not mention visa or relocation');
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

describe('skills and clusters follow the stack presets (config.stacks)', () => {
  const asStacks = (stacks: string[], fn: () => void) => {
    const was = config.stacks;
    config.stacks = stacks;
    try {
      fn();
    } finally {
      if (was === undefined) delete config.stacks;
      else config.stacks = was;
    }
  };

  it('the default stacks give exactly the skill list the bot always had', () => {
    assert.deepEqual(
      SKILLS.map((s) => s.name),
      // prettier-ignore
      [
        'PHP',
        'Laravel',
        'Livewire',
        'Filament',
        'Inertia.js',
        'Alpine.js',
        'JavaScript',
        'TypeScript',
        'Node.js',
        'NestJS',
        'Express.js',
        'React',
        'Next.js',
        'Redux',
        'Vue.js',
        'MongoDB',
        'PostgreSQL',
        'MySQL',
        'SQL',
        'Prisma',
        'TypeORM',
        'GraphQL',
        'REST APIs',
        'OAuth/JWT',
        'AWS',
        'Docker',
        'CI/CD',
        'Testing',
        'LLM / AI',
        'Microservices',
        'Angular',
        'Tailwind CSS',
        'Kubernetes',
        'Redis',
        'Kafka',
        'Terraform',
        'GCP',
        'Azure',
        'Python',
        'Go',
        'Java',
        'Ruby',
        'C#/.NET',
      ],
    );
    assert.equal(SKILLS.find((s) => s.name === 'Laravel')?.weight, 2);
    assert.equal(SKILLS.find((s) => s.name === 'SQL')?.cv?.test('MySQL'), true);
  });

  it('a python stack scores postings by its own skills', () => {
    asStacks(['python'], () => {
      const s = scoreJob(raw({ title: 'Senior Software Engineer', description: 'Django, FastAPI, PostgreSQL, Docker and pytest.' }));
      assert.ok(s.missing.includes('Django'), 'Django is seen and not on the CV');
      assert.ok(s.missing.includes('FastAPI'));
      assert.ok(s.matched.includes('PostgreSQL') && s.matched.includes('Docker'), 'the cross-stack skills still count');
    });
  });

  it('cross-stack markers still see postings built on another stack', () => {
    asStacks(['python'], () => {
      const s = scoreJob(raw({ title: 'Senior Software Engineer', description: 'Laravel back end with a React front end.' }));
      const names = [...s.matched, ...s.missing];
      assert.ok(names.includes('PHP'), 'Laravel counts as the PHP marker');
      assert.ok(names.includes('JavaScript'), 'React counts as the JavaScript marker');
      assert.ok(!names.includes('Laravel') && !names.includes('React'), 'the granular skills belong to their stacks');
    });
  });

  it('CV clusters follow the stacks', () => {
    asStacks(['python'], () => {
      assert.equal(pickCluster('Laravel, Livewire and Tailwind'), 'default');
    });
    asStacks(['javascript'], () => {
      assert.equal(pickCluster('MongoDB, Express, React, Node'), 'mern');
      assert.equal(pickCluster('PHP developer'), 'default');
    });
    assert.equal(pickCluster('Laravel, Livewire and Tailwind'), 'tall', 'the default stacks are back');
  });

  it('an unknown stack id fails loudly and names the known ones', () => {
    asStacks(['cobol'], () => {
      assert.throws(() => scoreJob(raw()), /unknown stack preset "cobol" \(known: javascript, php-laravel, python\)/);
      assert.throws(() => pickCluster('Laravel'), /unknown stack preset "cobol"/);
      assert.throws(() => scoreJob(raw()), ConfigError, 'a settings problem, so fetch stops once instead of per posting');
    });
  });
});

describe('scoreJob: a missing or corrupt master CV fails loudly', () => {
  // A fresh module instance per test (the ?query busts the ESM cache), so the lazy skill list is not loaded yet.
  const freshMatch = (name: string) => import(`../src/match.ts?${name}`) as Promise<typeof import('../src/match.ts')>;
  const withMaster = async (file: string, fn: () => void) => {
    const saved = process.env.JOB_BOT_MASTER;
    process.env.JOB_BOT_MASTER = file;
    try {
      fn();
    } finally {
      if (saved === undefined) delete process.env.JOB_BOT_MASTER;
      else process.env.JOB_BOT_MASTER = saved;
    }
  };

  it('throws a clear error when cv/master.json is missing, instead of scoring everything 0', async () => {
    const m = await freshMatch('missing-cv');
    await withMaster(join(tmpdir(), 'job-bot-no-such-cv.json'), () => {
      assert.throws(() => m.scoreJob(raw()), /Cannot read the master CV at .*job-bot-no-such-cv\.json.*JOB_BOT_MASTER/);
      assert.throws(() => m.scoreJob(raw()), ConfigError);
    });
  });

  it('throws a clear error when cv/master.json is not valid JSON', async () => {
    const m = await freshMatch('corrupt-cv');
    const f = join(mkdtempSync(join(tmpdir(), 'job-bot-cv-')), 'master.json');
    writeFileSync(f, '{ "skills": ');
    await withMaster(f, () => {
      assert.throws(() => m.scoreJob(raw()), /Cannot parse the master CV at .*master\.json as JSON/);
      assert.throws(() => m.scoreJob(raw()), ConfigError);
    });
  });
});

describe('compiled matchers', () => {
  it('cached config patterns still follow config changes (the cache is keyed on the pattern text)', () => {
    const was = config.roleExclude;
    try {
      config.roleExclude = 'full stack';
      assert.match(scoreJob(raw()).filterReason!, /title excluded/);
    } finally {
      config.roleExclude = was;
    }
    assert.equal(scoreJob(raw()).filterReason, null);
  });

  it('languageRules is built once per spoken-language set', () => {
    assert.equal(languageRules(['English']), languageRules(['english']));
    assert.notEqual(languageRules(['English']), languageRules(['English', 'Dutch']));
  });
});

describe('scoreJob: remote from India (rules follow remote.fromCode)', () => {
  const asIndia = (fn: () => void) => {
    const was = { ...config.remote };
    Object.assign(config.remote, { from: 'India', fromCode: 'IN' });
    try {
      fn();
    } finally {
      config.remote = was;
    }
  };

  it('accepts India, South Asia and IST remote jobs, and says to work from India', () => {
    asIndia(() => {
      for (const where of ['Remote — India', 'Remote, Bengaluru, India', 'Remote — South Asia', 'Remote (IST)', 'Remote, GMT+5:30']) {
        const s = scoreJob(raw({ location: where }));
        assert.equal(s.country, 'RM', where);
        assert.equal(s.filterReason, null, where);
      }
      assert.equal(scoreJob(raw({ location: 'Remote — Worldwide' })).visa, 'Remote: work from India, no visa needed');
    });
  });

  it('rejects remote jobs limited to a neighbour or to EMEA', () => {
    asIndia(() => {
      assert.match(scoreJob(raw({ location: 'Remote — Bangladesh' })).filterReason!, /remote, but only for: Bangladesh/);
      assert.match(scoreJob(raw({ location: 'Remote — EMEA' })).filterReason!, /remote, but only for: EMEA/);
    });
  });

  it('hand-written remote.allow still wins over the computed rules', () => {
    asIndia(() => {
      config.remote.allow = 'worldwide|emea';
      assert.equal(scoreJob(raw({ location: 'Remote — EMEA' })).country, 'RM');
      assert.match(scoreJob(raw({ location: 'Remote — India' })).filterReason!, /does not include India|only for: India/);
    });
  });
});
