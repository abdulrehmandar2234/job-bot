import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { crc32, deflateRawSync } from 'node:zlib';
import { TEST_DB } from './helpers.ts'; // first: it points the bot at a temp config before src/ loads one
import { path } from '../src/config.ts';
import { checkImported, cvSchema, docxText, draftFile, MIN_TEXT, readCvText, unzipEntry } from '../src/cv/import.ts';
import type { Cv } from '../src/cv/render.ts';

const tmp = mkdtempSync(join(tmpdir(), 'talaash-cv-import-'));
const file = (name: string, data: string | Buffer) => {
  const f = join(tmp, name);
  writeFileSync(f, data);
  return f;
};

/** A zip archive with the given files, deflated (method 8) or stored (method 0), as Word writes a .docx. */
function zip(files: Record<string, string>, method: 0 | 8 = 8): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc32(raw), 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(n.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    central.push(head, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A one-page PDF with these lines of text (Helvetica) and link annotations, with a correct cross-reference table. */
function pdf(lines: string[], links: string[] = []): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const content = `BT /F1 11 Tf 50 780 Td 14 TL ${lines.map((l) => `(${esc(l)}) '`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>${
      links.length ? ` /Annots [${links.map((_, i) => `${6 + i} 0 R`).join(' ')}]` : ''
    } >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...links.map(
      (url, i) => `<< /Type /Annot /Subtype /Link /Rect [50 ${700 - i * 20} 200 ${712 - i * 20}] /A << /S /URI /URI (${url}) >> >>`,
    ),
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const CV_TEXT = [
  'Jane Example',
  'Senior Backend Engineer · jane@example.com · Lisbon, Portugal',
  'Skills: PHP, Laravel, React.js, PostgreSQL, Docker',
  'Experience',
  'Backend Engineer, Example Travel, Lisbon, Jan 2022 — Present',
  '- Built the booking API in Laravel and PostgreSQL for 50,000 monthly users.',
  '- Moved the deployment to Docker and cut release time from a day to an hour.',
  'Education',
  'BSc Computer Science, University of Example, 2016 — 2020',
];

const draft = (o: Partial<Cv> = {}): Cv => ({
  name: 'Jane Example',
  title: 'Senior Backend Engineer',
  contact: { phone: '', email: 'jane@example.com', location: 'Lisbon, Portugal', linkedin: '' },
  summary: '',
  skills: [
    { group: 'Languages', items: ['PHP'] },
    { group: 'Frameworks', items: ['Laravel', 'React', 'Kubernetes'] },
    { group: 'Cloud', items: ['AWS'] },
  ],
  experience: [
    {
      role: 'Backend Engineer',
      company: 'Example Travel',
      location: 'Lisbon',
      dates: 'Jan 2022 — Present',
      tags: [],
      bullets: ['Built the booking API in Laravel and PostgreSQL for 50,000 monthly users.'],
    },
  ],
  projects: [],
  education: [{ school: 'University of Example', degree: 'BSc Computer Science', dates: '2016 — 2020' }],
  ...o,
});

describe('reading a CV file', () => {
  it('reads a .docx (deflated or stored) paragraph by paragraph, with entities decoded', () => {
    const xml =
      '<w:document><w:body><w:p><w:r><w:t>Jane &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>PHP</w:t><w:tab/><w:t>Laravel</w:t></w:r></w:p></w:body></w:document>';
    for (const method of [8, 0] as const) {
      const docx = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': xml }, method);
      assert.equal(docxText(docx), 'Jane & Co\nPHP\tLaravel');
    }
    assert.equal(unzipEntry(zip({ 'a.txt': 'x' }), 'word/document.xml'), null);
    assert.throws(() => docxText(zip({ 'a.txt': 'x' })), /no document text/);
  });

  it('reads PDF, .docx and text files, and refuses other types, huge files and files with almost no text', async () => {
    assert.match(await readCvText(file('cv.pdf', pdf(CV_TEXT))), /Jane Example[\s\S]*Laravel[\s\S]*University of Example, 2016\D+2020$/);
    // A link's URL is only in the link annotation ("LinkedIn" in the text): it is added after the text.
    const linked = await readCvText(file('linked.pdf', pdf(CV_TEXT, ['https://www.linkedin.com/in/jane/', 'mailto:jane@example.com'])));
    assert.match(linked, /2020\n\nLinks in the PDF:\nhttps:\/\/www\.linkedin\.com\/in\/jane\/$/);
    const docx = zip({ 'word/document.xml': `<w:document>${CV_TEXT.map((l) => `<w:p><w:t>${l}</w:t></w:p>`).join('')}</w:document>` });
    assert.match(await readCvText(file('cv.docx', docx)), /^Jane Example\nSenior Backend Engineer/);
    assert.equal(await readCvText(file('cv.md', `${CV_TEXT.join('\r\n')}\r\n`)), CV_TEXT.join('\n'));
    await assert.rejects(readCvText(file('cv.odt', 'x')), /Cannot import a \.odt: use one of \.pdf, \.docx, \.txt, \.md/);
    await assert.rejects(readCvText(file('short.txt', 'Jane')), /almost no text \(4 characters\)/);
    await assert.rejects(readCvText(file('big.txt', Buffer.alloc(6 * 1024 * 1024, 'a'))), /larger than 5 MB/);
    await assert.rejects(readCvText(join(tmp, 'missing.pdf')), /Cannot read/);
    await assert.rejects(readCvText(file('broken.pdf', `not a pdf ${'x'.repeat(MIN_TEXT)}`)), /Cannot read the PDF/);
  });
});

describe('checkImported', () => {
  it('drops skills the CV text does not contain, keeps ".js" spellings, and warns about names it cannot find', () => {
    const text = CV_TEXT.join('\n');
    const res = checkImported(draft(), text);
    assert.deepEqual(res.cv.skills, [
      { group: 'Languages', items: ['PHP'] },
      { group: 'Frameworks', items: ['Laravel', 'React'] },
    ]);
    assert.deepEqual(res.dropped, ['Kubernetes', 'AWS']);
    assert.deepEqual(res.warnings, []);
    const odd = checkImported(draft({ name: 'John Other', education: [{ school: 'Other College', degree: '', dates: '' }] }), text);
    assert.deepEqual(odd.warnings, ['The name "John Other" is not in the CV text.', 'The school "Other College" is not in the CV text.']);
    assert.ok(cvSchema.safeParse(res.cv).success);
    assert.ok(!cvSchema.safeParse({ ...res.cv, name: '' }).success);
  });
});

describe('bot cv:import', () => {
  const run = promisify(execFile);
  const data = mkdtempSync(join(tmpdir(), 'talaash-cv-import-data-'));
  const master = join(mkdtempSync(join(tmpdir(), 'talaash-cv-import-master-')), 'master.json');
  const backups = mkdtempSync(join(tmpdir(), 'talaash-cv-import-backups-'));
  const env = {
    ...process.env,
    DATABASE_URL: TEST_DB,
    JOB_BOT_CLAUDE: join(import.meta.dirname, 'fixtures', 'fake-claude.mjs'),
    FAKE_CLAUDE_OUT: JSON.stringify(draft()),
    JOB_BOT_DATA_DIR: data,
    JOB_BOT_MASTER: master,
    JOB_BOT_CV_BACKUP_DIR: backups,
  };
  const bot = async (args: string[]) =>
    (await run(process.execPath, ['--no-warnings', 'src/cli.ts', ...args], { cwd: path(), env, timeout: 60_000 })).stdout;
  const draftPath = join(data, 'cv-import', 'draft.json');

  it('saves a checked draft, applies it over the master CV after a backup, and never touches the master before', async () => {
    assert.equal(draftFile().endsWith(join('cv-import', 'draft.json')), true);
    writeFileSync(master, '{"name":"Old CV"}');
    const out = await bot(['cv:import', file('jane.txt', CV_TEXT.join('\n'))]);
    assert.match(out, /Read jane\.txt: Jane Example, Senior Backend Engineer/);
    assert.match(out, /Found {6}: 1 jobs, 3 skills, 0 projects, 1 education/);
    assert.match(out, /Left out {3}: Kubernetes, AWS \(not in your CV's text\)/);
    assert.match(out, /npm run bot -- cv:import --apply/);
    const saved = JSON.parse(readFileSync(draftPath, 'utf8'));
    assert.equal(saved.source, 'jane.txt');
    assert.deepEqual(saved.dropped, ['Kubernetes', 'AWS']);
    assert.equal(readFileSync(master, 'utf8'), '{"name":"Old CV"}', 'the master CV is untouched until --apply');

    const applied = await bot(['cv:import', '--apply']);
    assert.match(applied, /Saved as your master CV/);
    assert.equal(JSON.parse(readFileSync(master, 'utf8')).name, 'Jane Example');
    assert.equal(JSON.parse(readFileSync(master, 'utf8')).skills[1].items.includes('Kubernetes'), false);
    const [backup] = readdirSync(backups);
    assert.equal(readFileSync(join(backups, backup), 'utf8'), '{"name":"Old CV"}');
    assert.equal(existsSync(draftPath), false);
  });

  it('--discard removes the draft; --apply without a draft and a file of the wrong type are user errors', async () => {
    assert.match(await bot(['cv:import', file('upload.txt', CV_TEXT.join('\n')), '--name=My CV.docx']), /^Read My CV\.docx: Jane/);
    assert.equal(JSON.parse(readFileSync(draftPath, 'utf8')).source, 'My CV.docx');
    assert.match(await bot(['cv:import', '--discard']), /Imported draft removed/);
    assert.equal(existsSync(draftPath), false);
    for (const args of [
      ['cv:import', '--apply'],
      ['cv:import', file('cv.odt', 'x')],
    ]) {
      await assert.rejects(bot(args), (e: { stderr: string; code: number }) => {
        assert.equal(e.code, 1);
        assert.doesNotMatch(e.stderr, /\n\s+at /, 'a UserError: no stack trace');
        return true;
      });
    }
  });
});
