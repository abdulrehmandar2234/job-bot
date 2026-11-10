import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import './helpers.ts';
import { config, path } from '../src/config.ts';
import { resolveChrome } from '../src/cv/chrome.ts';
import { PROFILE_FACTS, profileFor, profileMisfits } from '../src/cv/profile-fit.ts';
import { PROFILES } from '../src/cv/profiles.ts';
import type { Cv } from '../src/cv/render.ts';
import { customVersion, versionFor } from '../src/cv/versions.ts';
import { versionCv } from '../src/ats.ts';

// The cluster profiles (src/cv/profiles.ts) were written for the owner's master CV. Their title and summary go on a
// CV only when that CV's master shows everything they name; another user's version keeps its own title and summary.
const owner = JSON.parse(readFileSync(path('tests', 'fixtures', 'master-owner.json'), 'utf8')) as Cv;
const jane = JSON.parse(readFileSync(path('cv', 'master.example.json'), 'utf8')) as Cv;
const noChrome = !resolveChrome(config.chromePath) && 'Chrome not installed';

// cv/versions/ before the tests: anything new afterwards was made by a test and is removed.
const VERSIONS = path('cv', 'versions');
const existing = new Set(existsSync(VERSIONS) ? readdirSync(VERSIONS) : []);
after(() => {
  delete process.env.JOB_BOT_MASTER;
  if (existsSync(VERSIONS))
    for (const d of readdirSync(VERSIONS)) if (!existing.has(d)) rmSync(join(VERSIONS, d), { recursive: true, force: true });
});
const cvJson = (id: string) => JSON.parse(readFileSync(path('cv', 'versions', id, 'cv.json'), 'utf8')) as Cv;

describe('profileFor', () => {
  for (const cluster of Object.keys(PROFILES)) {
    it(`"${cluster}": the owner's CV gets the profile unchanged; the example CV keeps its own title and summary`, () => {
      assert.deepEqual(profileMisfits(cluster, owner), []);
      assert.equal(profileFor(cluster, owner), PROFILES[cluster], 'the very same profile: the owner output stays identical');

      assert.ok(profileMisfits(cluster, jane).length > 0);
      const p = profileFor(cluster, jane)!;
      assert.deepEqual([p.title, p.summary], [jane.title, jane.summary]);
      // The orderings only re-order the user's own content, so they stay.
      assert.deepEqual(
        [p.skillsFirst, p.groupsFirst, p.projectTags, p.bulletKeywords],
        [PROFILES[cluster].skillsFirst, PROFILES[cluster].groupsFirst, PROFILES[cluster].projectTags, PROFILES[cluster].bulletKeywords],
      );
    });
  }

  it('names what is missing: unknown skills, numbers, employers and facts', () => {
    const misfits = profileMisfits('ai-fullstack', jane);
    for (const m of ['NestJS', '5,000', 'Qureos', 'AI Screening', 'Artificial Intelligence']) assert.ok(misfits.includes(m), m);
  });

  it('decides on the CV content, not on whose CV it is', () => {
    // Someone else's name and contact on a CV with the owner's content: the text fits.
    const cv: Cv = { ...owner, name: jane.name, contact: jane.contact };
    assert.equal(profileFor('backend-node', cv), PROFILES['backend-node']);
    // The owner's content without the employer the summary names: it does not.
    const text = (s: string) => s.replaceAll('Qureos', 'Acme');
    const other: Cv = {
      ...cv,
      summary: text(cv.summary),
      experience: cv.experience.map((e) => ({ ...e, company: text(e.company), bullets: e.bullets.map(text) })),
      projects: cv.projects.map((x) => ({ ...x, name: text(x.name), text: text(x.text) })),
    };
    assert.deepEqual(profileMisfits('backend-node', other), ['Qureos']);
    assert.equal(profileFor('backend-node', other)!.summary, other.summary);
  });

  it('is undefined for a cluster without a profile', () => {
    assert.equal(profileFor('default', owner), undefined);
    assert.deepEqual(profileMisfits('nope', jane), []);
  });

  it('PROFILE_FACTS covers every profile and every owner employer a profile names', () => {
    assert.deepEqual(Object.keys(PROFILE_FACTS).sort(), Object.keys(PROFILES).sort());
    const employers = [...new Set(owner.experience.map((e) => e.company))];
    for (const [cluster, p] of Object.entries(PROFILES)) {
      const text = `${p.title}\n${p.summary}`.toLowerCase();
      for (const e of employers) if (text.includes(e.toLowerCase())) assert.ok(PROFILE_FACTS[cluster].includes(e), `${cluster}: ${e}`);
    }
  });
});

describe('ats versionCv', () => {
  it('previews a cluster version as it would be built', () => {
    assert.equal(versionCv(owner, 'laravel').title, PROFILES.laravel.title);
    const v = versionCv(jane, 'laravel');
    assert.deepEqual([v.title, v.summary], [jane.title, jane.summary]);
  });
});

describe('built versions (versionFor: prepare --cv, cv:build; customVersion: custom)', { skip: noChrome }, () => {
  it("the example CV's cluster and custom versions keep its own title and summary", async () => {
    process.env.JOB_BOT_MASTER = path('cv', 'master.example.json');
    try {
      const built = await versionFor('laravel');
      assert.deepEqual([cvJson(built.id).title, cvJson(built.id).summary], [jane.title, jane.summary]);
      const custom = await customVersion('fit-jane', 'mern', 'test:fit', { skillsFirst: ['React'] });
      assert.deepEqual([cvJson(custom.id).title, cvJson(custom.id).summary], [jane.title, jane.summary]);
      // An override still wins (cv:tailor's job summary, custom --overrides).
      const tailored = await customVersion('fit-jane', 'mern', 'test:fit', { summary: 'Jane builds booking platforms.' });
      assert.equal(cvJson(tailored.id).summary, 'Jane builds booking platforms.');
      assert.equal(cvJson(tailored.id).title, jane.title);
    } finally {
      delete process.env.JOB_BOT_MASTER;
    }
  });

  it("the owner's versions keep the profile text", async () => {
    const built = await versionFor('laravel');
    assert.deepEqual([cvJson(built.id).title, cvJson(built.id).summary], [PROFILES.laravel.title, PROFILES.laravel.summary]);
    const custom = await customVersion('fit-owner', 'mern', 'test:fit', {});
    assert.deepEqual([cvJson(custom.id).title, cvJson(custom.id).summary], [PROFILES.mern.title, PROFILES.mern.summary]);
  });
});
