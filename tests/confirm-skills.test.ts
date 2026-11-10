import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './owner-cv.ts'; // the master CV for match.ts's skill list
import { path } from '../src/config.ts';
import { SKILLS } from '../src/match.ts';
import { addSkills, backupDir, confirmSkills, cvItem, groupFor, OTHER_GROUP, parseSkills, SKILL_NAMES } from '../src/cv/confirm-skills.ts';
import type { Cv } from '../src/cv/render.ts';

// "I have this" on the CV keyword check: confirmed job skills go on the master CV, in the right group, with a backup.

const example = () => JSON.parse(readFileSync(path('cv', 'master.example.json'), 'utf8')) as Cv;
const groups = example().skills.map((g) => g.group);

describe('groupFor', () => {
  it('puts each kind of skill in the master group whose name fits it', () => {
    assert.equal(groupFor('Python', groups), 'Languages & Runtimes');
    assert.equal(groupFor('Vue.js', groups), 'Frameworks & Libraries');
    assert.equal(groupFor('Redis', groups), 'Databases & ORMs');
    assert.equal(groupFor('Kafka', groups), 'APIs & Web');
    assert.equal(groupFor('Kubernetes', groups), 'DevOps & Tools');
    assert.equal(groupFor('Testing', groups), 'Testing & Practices');
    assert.equal(groupFor('LLM / AI', [...groups, 'AI Tools & Agentic Development']), 'AI Tools & Agentic Development');
  });

  it('falls back to Other Skills when no group fits', () => {
    assert.equal(groupFor('LLM / AI', groups), OTHER_GROUP);
    assert.equal(groupFor('Kubernetes', ['Languages']), OTHER_GROUP);
  });
});

describe('addSkills', () => {
  it('adds confirmed skills at the end of their group and keeps everything else', () => {
    const master = example();
    const { cv, added } = addSkills(master, ['Kubernetes', 'Python', 'Kubernetes']);
    assert.deepEqual(added, ['Kubernetes', 'Python']);
    assert.deepEqual(cv.skills.find((g) => g.group === 'DevOps & Tools')!.items, ['Docker', 'AWS', 'Git', 'Kubernetes']);
    assert.deepEqual(cv.skills.find((g) => g.group === 'Languages & Runtimes')!.items.at(-1), 'Python');
    assert.deepEqual({ ...cv, skills: master.skills }, master, 'only the skills change');
    assert.equal(master.skills[4].items.length, 3, 'the input is not changed');
  });

  it('skips skills the CV already shows, also under other wording, and makes Other Skills when needed', () => {
    const { cv, added } = addSkills(example(), ['Docker', 'SQL', 'LLM / AI']);
    assert.deepEqual(added, ['LLM / AI'], 'Docker is there, PostgreSQL proves SQL');
    assert.deepEqual(cv.skills.at(-1), { group: OTHER_GROUP, items: ['LLM / AI'] });
  });

  it('writes every skill so the keyword check finds it on the CV afterwards', () => {
    for (const name of SKILL_NAMES) {
      const s = SKILLS.find((x) => x.name === name)!;
      assert.ok(s.re.test(cvItem(name)) || s.cv?.test(cvItem(name)), `${name} → ${cvItem(name)}`);
    }
    assert.equal(cvItem('Go'), 'Go (Golang)');
  });
});

describe('parseSkills', () => {
  it('reads a comma list of known skill names', () => {
    assert.deepEqual(parseSkills(undefined), []);
    assert.deepEqual(parseSkills(' Docker, GraphQL ,Docker'), ['Docker', 'GraphQL']);
  });

  it('refuses an empty flag and unknown names', () => {
    for (const flag of ['', 'true', ' , ']) assert.match((parseSkills(flag) as { error: string }).error, /needs skill names/);
    assert.match((parseSkills('Docker,Cobol') as { error: string }).error, /Unknown skill: Cobol/);
  });
});

describe('confirmSkills', () => {
  const env = { master: process.env.JOB_BOT_MASTER, backups: process.env.JOB_BOT_CV_BACKUP_DIR, data: process.env.JOB_BOT_DATA_DIR };
  afterEach(() => {
    for (const [k, v] of [
      ['JOB_BOT_MASTER', env.master],
      ['JOB_BOT_CV_BACKUP_DIR', env.backups],
      ['JOB_BOT_DATA_DIR', env.data],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  it('backs the master CV up, then writes it with the skills added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobbot-confirm-'));
    const file = join(dir, 'master.json');
    const before = readFileSync(path('cv', 'master.example.json'), 'utf8');
    writeFileSync(file, before);
    process.env.JOB_BOT_MASTER = file;
    process.env.JOB_BOT_CV_BACKUP_DIR = join(dir, 'backups');

    const res = confirmSkills(['Kubernetes'], new Date('2026-11-03T10:20:30.400Z'));
    assert.deepEqual(res, { added: ['Kubernetes'], backup: join(dir, 'backups', 'master-2026-11-03T10-20-30-400Z.json') });
    assert.equal(readFileSync(res.backup!, 'utf8'), before);
    const after = readFileSync(file, 'utf8');
    assert.ok(after.endsWith('}\n'));
    assert.ok((JSON.parse(after) as Cv).skills.some((g) => g.items.includes('Kubernetes')));

    assert.deepEqual(confirmSkills(['Kubernetes', 'Docker']), { added: [], backup: null }, 'nothing new: nothing written');
    assert.equal(readdirSync(join(dir, 'backups')).length, 1);
  });

  it('without JOB_BOT_CV_BACKUP_DIR backs up into cv-backups in the data dir (JOB_BOT_DATA_DIR)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobbot-confirm-data-'));
    const file = join(dir, 'master.json');
    writeFileSync(file, readFileSync(path('cv', 'master.example.json'), 'utf8'));
    process.env.JOB_BOT_MASTER = file;
    delete process.env.JOB_BOT_CV_BACKUP_DIR;
    process.env.JOB_BOT_DATA_DIR = join(dir, 'data');
    assert.equal(backupDir(), join(dir, 'data', 'cv-backups'));
    const res = confirmSkills(['Kubernetes'], new Date('2026-11-03T10:20:30.400Z'));
    assert.equal(res.backup, join(dir, 'data', 'cv-backups', 'master-2026-11-03T10-20-30-400Z.json'));
    // The explicit override still wins over the data dir.
    process.env.JOB_BOT_CV_BACKUP_DIR = join(dir, 'elsewhere');
    assert.equal(backupDir(), join(dir, 'elsewhere'));
  });
});
