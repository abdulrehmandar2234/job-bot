import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChrome } from '../src/cv/chrome.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import './helpers.ts';
import { config, path } from '../src/config.ts';
import { cvHtml, renderPdf, type Cv } from '../src/cv/render.ts';
import { DEFAULT_TEMPLATE, isTemplate, TEMPLATE_IDS, TEMPLATES, templateHtml } from '../src/cv/templates/index.ts';
import { defaultTemplate, jobTemplate, masterHash, versionTemplate } from '../src/cv/versions.ts';
import { validateConfig } from '../src/settings.ts';
import { legacyCvHtml } from './fixtures/cv-classic-legacy.ts';

const read = (f: string) => JSON.parse(readFileSync(path('cv', f), 'utf8')) as Cv;
const master = JSON.parse(readFileSync(path('tests', 'fixtures', 'master-owner.json'), 'utf8')) as Cv;
const example = read('master.example.json');
const hasChrome = Boolean(resolveChrome(config.chromePath));
const text = (html: string) =>
  html
    .replace(/<style>[\s\S]*<\/style>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

describe('CV templates', () => {
  it('lists classic, modern and compact, each with a name and a description; classic is the default', () => {
    assert.deepEqual([...TEMPLATE_IDS], ['classic', 'modern', 'compact']);
    assert.equal(DEFAULT_TEMPLATE, 'classic');
    for (const id of TEMPLATE_IDS) {
      assert.equal(TEMPLATES[id].id, id);
      assert.ok(TEMPLATES[id].name && TEMPLATES[id].description);
      assert.ok(existsSync(path('src', 'cv', 'templates', `${id}.ts`)), `one file per template: ${id}.ts`);
    }
    assert.ok(isTemplate('modern'));
    for (const bad of ['Modern', 'fancy', '', null, 3, '../classic']) assert.equal(isTemplate(bad), false);
  });

  it('classic is byte-identical to the CV design before templates (the golden copy), for the owner and the example CV', () => {
    for (const cv of [master, example]) {
      assert.equal(templateHtml('classic', cv), legacyCvHtml(cv));
      assert.equal(cvHtml(cv), legacyCvHtml(cv));
    }
  });

  it('classic leaves out an empty Projects section and is otherwise unchanged', () => {
    const html = templateHtml('classic', { ...example, projects: [] });
    assert.doesNotMatch(html, /Projects/);
    assert.equal(html, legacyCvHtml({ ...example, projects: [] }).replace('\n  <h2>Projects</h2>\n  \n', ''));
  });

  for (const id of TEMPLATE_IDS) {
    describe(id, () => {
      it('renders every section and all CV content as real text, on A4, with no images, tables or scripts', () => {
        const html = templateHtml(id, master);
        assert.match(html, /^<!doctype html>/);
        assert.match(html, /@page \{ size: A4/);
        assert.doesNotMatch(html, /<(img|table|svg|script|canvas|iframe)\b/i);
        for (const section of ['Summary', 'Skills', 'Work Experience', 'Projects', 'Education'])
          assert.match(html, new RegExp(`<h2>[^<]*${section}`));
        const plain = text(html);
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        for (const s of [
          master.name,
          master.title,
          master.summary,
          master.contact.email,
          ...master.skills.flatMap((g) => [g.group, ...g.items]),
          ...master.experience.flatMap((e) => [e.role, e.company, e.dates, ...e.bullets]),
          ...master.projects.flatMap((p) => [p.name, p.text]),
          ...master.education.flatMap((e) => [e.school, e.degree]),
        ])
          assert.ok(plain.includes(esc(s).replace(/\s+/g, ' ')), `${id} shows "${s}"`);
      });

      it('escapes HTML in every field', () => {
        const evil = '<script>alert("x")</script> & co';
        const cv: Cv = {
          ...example,
          name: evil,
          title: evil,
          summary: evil,
          skills: [{ group: evil, items: [evil] }],
          experience: [{ ...example.experience[0], role: evil, company: evil, bullets: [evil] }],
          projects: [{ ...example.projects[0], name: evil, text: evil }],
          education: [{ school: evil, degree: evil, dates: evil }],
        };
        const html = templateHtml(id, cv);
        assert.doesNotMatch(html, /<script>/);
        assert.match(html, /&lt;script&gt;alert\("x"\)&lt;\/script&gt; &amp; co/);
      });

      it('leaves out an empty Projects section', () => {
        assert.doesNotMatch(templateHtml(id, { ...example, projects: [] }), /<h2>Projects/);
      });

      it('prints a PDF with Chrome', { skip: !hasChrome && 'Chrome not installed', timeout: 60_000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), `jobbot-tpl-${id}-`));
        try {
          const out = join(dir, config.cvFileName);
          await renderPdf(master, out, id);
          assert.equal(readFileSync(out).subarray(0, 5).toString(), '%PDF-');
          assert.ok(statSync(out).size > 10_000);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    });
  }

  it('modern has a name banner and an accent colour; compact uses a smaller font than classic', () => {
    assert.match(templateHtml('modern', example), /<header>\s*<h1>Jane Doe<\/h1>/);
    assert.match(templateHtml('modern', example), /#0f766e/);
    const size = (id: 'classic' | 'compact') => Number(templateHtml(id, example).match(/body \{[^}]*font-size: ([\d.]+)pt/)![1]);
    assert.ok(size('compact') < size('classic'));
  });

  it('the new templates leave out empty contact fields', () => {
    const cv = { ...example, contact: { phone: '', email: 'jane@example.com', location: '', linkedin: '' } };
    for (const id of ['modern', 'compact'] as const) {
      const contact = templateHtml(id, cv).match(/<div class="contact">(.*)<\/div>/)![1];
      assert.doesNotMatch(contact, /LinkedIn|^ ?[|·]|[|·] ?[|·]/);
      assert.match(contact, /jane@example\.com/);
    }
  });
});

describe('choosing a template', () => {
  it('a job uses its own template, else config.json cvTemplate, else classic', () => {
    assert.equal(defaultTemplate(), config.cvTemplate ?? 'classic');
    assert.equal(jobTemplate({ cv_template: 'compact' }), 'compact');
    assert.equal(jobTemplate({ cv_template: null }), defaultTemplate());
    assert.equal(jobTemplate({ cv_template: 'gone' }), defaultTemplate(), 'an unknown name falls back');
    assert.equal(jobTemplate({}), defaultTemplate());
  });

  it('a version without a template in meta.json is classic (made before templates existed)', () => {
    assert.equal(versionTemplate({}), 'classic');
    assert.equal(versionTemplate(null), 'classic');
    assert.equal(versionTemplate({ template: 'modern' }), 'modern');
  });

  it('the version hash differs per template, so each template has versions of its own', () => {
    const hashes = TEMPLATE_IDS.map((t) => masterHash(t));
    assert.equal(new Set(hashes).size, hashes.length);
    assert.equal(masterHash(), masterHash('classic'));
  });

  it('config.json cvTemplate is optional and must name a template', () => {
    const cfg = JSON.parse(readFileSync(path('config.default.json'), 'utf8'));
    delete cfg.cvTemplate;
    assert.equal(validateConfig(cfg).ok, true);
    for (const t of TEMPLATE_IDS) assert.equal(validateConfig({ ...cfg, cvTemplate: t }).ok, true);
    const bad = validateConfig({ ...cfg, cvTemplate: 'fancy' });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.errors[0].path, 'cvTemplate');
  });
});
