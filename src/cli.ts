import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { config, path } from './config.ts';
import { dedupe, getJob, migrate, pool, setStatus, upsertJob, type Job, type JobStatus } from './db.ts';
import { fetchCompany, type RawJob } from './sources/index.ts';
import { scoreJob } from './match.ts';
import { updateIndRegister } from './sponsors.ts';
import { cvFile, customVersion, listVersions, masterRaw, versionFor } from './cv/versions.ts';
import { renderPdf, type Cv } from './cv/render.ts';
import { PROFILES } from './cv/profiles.ts';
import { coverLetter } from './cover.ts';
import { aiAnswers, aiCoverLetter, aiScore } from './ai.ts';
import { addToConfig, discover } from './discover.ts';
import { BOARDS } from './sources/boards.ts';
import { linkedin } from './sources/linkedin.ts';

const [cmd, ...rest] = process.argv.slice(2);
const flags: Record<string, string> = {};
const args: string[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[i + 1]?.startsWith('--') || rest[i + 1] === undefined ? 'true' : rest[++i];
  else args.push(rest[i]);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
const today = () => new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD

function save(raw: RawJob) {
  const s = scoreJob(raw);
  return upsertJob({
    ...raw,
    country: s.country,
    score: s.score,
    cluster: s.cluster,
    matched: s.matched,
    missing: s.missing,
    visa: s.visa,
    flags: s.flags,
    status: s.filterReason ? 'filtered' : 'new',
    filter_reason: s.filterReason,
  });
}

function row(j: Job) {
  return `${String(j.score).padStart(3)}  ${(j.country ?? '--').padEnd(2)}  ${j.status.padEnd(9)} ${j.company} — ${j.title}  [${j.cluster}]` +
    `${j.flags.length ? `  ⚠ ${j.flags.join('; ')}` : ''}\n      id: ${j.id}`;
}

const commands: Record<string, () => Promise<void> | void> = {
  async 'sponsors:update'() {
    console.log(`IND register saved: ${await updateIndRegister()} recognised sponsors`);
  },

  async fetch() {
    const only = flags.company?.toLowerCase();
    const { rows: [run] } = await pool.query<{ id: number }>('INSERT INTO fetch_runs DEFAULT VALUES RETURNING id');
    const before = (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE status = 'new'`)).rows[0].n;
    let added = 0, total = 0;
    const errors: { company: string; error: string }[] = [];
    const sources: { name: string; load: () => Promise<RawJob[]> }[] = [
      ...config.companies.map((c) => ({ name: c.name, load: () => fetchCompany(c) })),
      ...(config.remote.enabled ? config.remote.boards.filter((b) => BOARDS[b]).map((b) => ({ name: b, load: BOARDS[b] })) : []),
      ...(config.linkedin.enabled ? [{ name: 'linkedin', load: linkedin }] : []),
    ];
    const queue = sources.filter((s) => !only || s.name.toLowerCase().includes(only));
    // 4 sources at a time; Workable spaces its own calls inside the adapter.
    const worker = async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          const jobs = await c.load();
          for (const j of jobs) if ((await save(j)) === 'inserted') added++;
          total += jobs.length;
          console.log(`✓ ${c.name}: ${jobs.length} postings`);
        } catch (e) {
          errors.push({ company: c.name, error: (e as Error).message });
          console.log(`✗ ${c.name}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const waiting = (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE status = 'new'`)).rows[0].n;
    await pool.query(`UPDATE fetch_runs SET finished_at = now(), checked = $2, inserted = $3, new_matches = $4, errors = $5 WHERE id = $1`,
      [run.id, total, added, Math.max(0, waiting - before), JSON.stringify(errors)]);
    console.log(`\n${total} postings checked, ${added} new. ${waiting} matching jobs waiting (status=new).`);
  },

  dedupe() {}, // grouping itself runs after the command, see below

  /** Re-applies filters and scoring to stored jobs after config.json / match.ts changes (no network). */
  async rescore() {
    const { rows } = await pool.query<Job>(`SELECT * FROM jobs WHERE status IN ('new', 'filtered')`);
    for (const j of rows) {
      await save({ id: j.id, source: j.source, company: j.company, title: j.title, location: j.location, url: j.url,
        description: j.description, posted_at: j.posted_at ? new Date(j.posted_at).toISOString() : null });
    }
    const waiting = (await pool.query<{ n: number }>(`SELECT count(*)::int n FROM jobs WHERE status = 'new'`)).rows[0].n;
    console.log(`${rows.length} jobs re-scored. ${waiting} matching jobs waiting (status=new).`);
  },

  /** Find which job board companies use: discover careem salla foodics [--add] */
  async discover() {
    const hits = await discover(args);
    for (const h of hits) console.log(`${h.target ? '★' : ' '} ${h.ats.padEnd(15)} ${h.slug.padEnd(22)} jobs=${h.jobs} in target countries=${h.target}`);
    if (!hits.length) console.log('No public job board found for these names (try other spellings, e.g. "acme", "acmeinc", "acme-tech").');
    if (flags.add) for (const c of addToConfig(hits)) console.log(`added to config.json: ${c.name} (${c.ats}:${c.token})`);
  },

  /** Add a job found manually or by Claude in the browser (LinkedIn, Bayt, GulfTalent, ...). JSON via --file or stdin. */
  async add() {
    const input = JSON.parse(flags.file ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8'));
    for (const j of Array.isArray(input) ? input : [input]) {
      const source = j.source ?? 'manual';
      const id = `${source}:${createHash('sha1').update(j.url).digest('hex').slice(0, 12)}`;
      await save({ id, source, company: j.company, title: j.title, location: j.location ?? '', url: j.url,
        description: j.description ?? '', posted_at: j.posted_at ?? null });
      const saved = (await getJob(id))!;
      console.log(saved.status === 'filtered' ? `filtered: ${saved.filter_reason}\n      id: ${id}` : row(saved));
    }
  },

  async list() {
    const status = flags.status ?? 'new';
    const where = ['status = $1'];
    const params: (string | number)[] = [status];
    if (flags.country) { params.push(flags.country.toUpperCase()); where.push(`country = $${params.length}`); }
    if (flags.min) { params.push(Number(flags.min)); where.push(`score >= $${params.length}`); }
    params.push(Number(flags.limit ?? 30));
    const { rows: jobs } = await pool.query<Job>(
      `SELECT * FROM jobs WHERE ${where.join(' AND ')} ORDER BY score DESC, posted_at DESC NULLS LAST LIMIT $${params.length}`, params);
    if (status === 'filtered') {
      for (const j of jobs) console.log(`${j.company} — ${j.title} (${j.location})\n      ✗ ${j.filter_reason}`);
    } else {
      console.log('score cc  status    company — title  [suggested cv version]');
      for (const j of jobs) console.log(row(j));
    }
    if (!jobs.length) console.log(`No jobs with status=${status}.`);
  },

  async show() {
    const j = await getJob(args[0]);
    if (!j) return console.log('Not found');
    console.log(`${j.company} — ${j.title}\n${j.location} (${j.country ?? '?'})\n${j.url}\n`);
    console.log(`Score ${j.score} | status ${j.status} | CV cluster ${j.cluster} | CV version ${j.cv_version ?? '-'}`);
    console.log(`Visa: ${j.visa ?? 'unknown'}`);
    console.log(`Matched: ${j.matched.join(', ')}`);
    console.log(`Missing: ${j.missing.join(', ') || '-'}`);
    if (j.flags.length) console.log(`Flags: ${j.flags.join('; ')}`);
    if (j.filter_reason) console.log(`Filtered: ${j.filter_reason}`);
    if (j.notes) console.log(`Notes: ${j.notes}`);
    if (flags.full) console.log(`\n${j.description}`);
  },

  /** Picks or builds the CV version and writes a cover letter. Does not apply. */
  async prepare() {
    const j = await getJob(args[0]);
    if (!j) return console.log('Not found');
    const forced = flags.cv; // --cv default | --cv laravel | --cv custom-xyz
    const cluster = forced ?? (config.autoCvVersions ? j.cluster ?? 'default' : 'default');
    const { id, created } = forced && !PROFILES[forced] ? { id: forced, created: false } : await versionFor(cluster);
    // AI reads the job description; the template is the fallback (AI off, --template, or the CLI failing).
    let letter = coverLetter(j);
    let aiLetter = false;
    if (config.ai.enabled && !flags.template) {
      try {
        letter = await aiCoverLetter(j);
        aiLetter = true;
      } catch (e) {
        console.log(`AI cover letter failed, using template: ${(e as Error).message}`);
      }
    }
    const dir = path('applications', `${today()}-${slug(j.company)}-${slug(j.title)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/cover-letter.txt`, letter);
    writeFileSync(`${dir}/application.json`, JSON.stringify({
      jobId: j.id, company: j.company, title: j.title, applyUrl: j.url, cvVersion: id, cvFile: cvFile(id), preparedAt: new Date().toISOString(),
    }, null, 2));
    await pool.query('UPDATE jobs SET cv_version = $2, cover_letter = $3, cover_letter_ai = $4 WHERE id = $1', [j.id, id, letter, aiLetter]);
    // Preparing a filtered/skipped job is a manual override, so it moves into the pipeline too.
    if (['new', 'filtered', 'skipped'].includes(j.status)) await setStatus(j.id, 'prepared', `CV: ${id}`);
    console.log(`${j.company} — ${j.title}`);
    console.log(`CV version : ${id}${created ? ' (newly generated)' : ''}`);
    if (id === 'default' && j.cluster && j.cluster !== 'default') console.log(`             (if needed, a "${j.cluster}" version can be made: prepare ${j.id} --cv ${j.cluster})`);
    console.log(`CV file    : ${cvFile(id)}`);
    console.log(`Cover      : ${dir}/cover-letter.txt ${aiLetter ? '(written by AI from the job description)' : '(template)'}`);
    console.log(`Apply at   : ${j.url}`);
    console.log(`\nAfter submitting: npm run bot -- mark ${j.id} applied`);
  },

  /** AI review of matching jobs via the local Claude CLI: ai:score [--id <job>] [--limit 80] [--all] */
  async 'ai:score'() {
    const params: (string | number)[] = [];
    let where = `status = 'new' AND duplicate_of IS NULL AND ai_scored_at IS NULL`;
    if (flags.id) { where = 'id = $1'; params.push(flags.id); }
    else if (flags.all) where = `status = 'new' AND duplicate_of IS NULL`;
    params.push(Number(flags.limit ?? config.ai.maxScorePerRun));
    const { rows: queue } = await pool.query<Job>(
      `SELECT * FROM jobs WHERE ${where} ORDER BY score DESC, posted_at DESC NULLS LAST LIMIT $${params.length}`, params);
    if (!queue.length) return console.log('Nothing to score.');
    console.log(`AI scoring ${queue.length} jobs with ${config.ai.scoreModel}...`);
    let done = 0;
    const worker = async () => {
      for (let j = queue.shift(); j; j = queue.shift()) {
        try {
          const r = await aiScore(j);
          await pool.query(`UPDATE jobs SET ai_score = $2, ai_verdict = $3, ai_summary = $4, ai_reasons = $5, ai_gaps = $6,
            ai_flags = $7, ai_scored_at = now() WHERE id = $1`, [j.id, r.score, r.verdict, r.summary, r.reasons, r.gaps, r.red_flags]);
          console.log(`${String(r.score).padStart(3)} ${r.verdict.padEnd(7)} ${j.company} — ${j.title}`);
          done++;
        } catch (e) {
          console.log(`  ✗ ${j.company} — ${j.title}: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: config.ai.concurrency }, worker));
    console.log(`${done} jobs scored.`);
  },

  /** Drafts answers to application-form questions: answer <id> [--file questions.txt] (or stdin) [--clear]. Never submits. */
  async answer() {
    const j = await getJob(args[0]);
    if (!j) return console.log('Not found');
    if (flags.clear) {
      await pool.query(`UPDATE jobs SET form_answers = '[]' WHERE id = $1`, [j.id]);
      return console.log('Answers cleared.');
    }
    const questions = (flags.file ? readFileSync(flags.file, 'utf8') : readFileSync(0, 'utf8')).trim();
    if (!questions) return console.log('No questions given.');
    const fresh = await aiAnswers(j, questions);
    // Re-asked questions replace their old answer; the rest are kept.
    const key = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const old = j.form_answers.filter((a) => !fresh.some((f) => key(f.question) === key(a.question)));
    await pool.query('UPDATE jobs SET form_answers = $2 WHERE id = $1', [j.id, JSON.stringify([...old, ...fresh])]);
    for (const a of fresh) console.log(`\nQ: ${a.question}\nA: ${a.answer}${a.note ? `\n   (${a.note})` : ''}`);
    const todo = fresh.filter((a) => a.needs_input).length;
    if (todo) console.log(`\n${todo} answer(s) need your input ([FILL: ...]). Add the facts to cv/applicant.json to fill them next time.`);
  },

  /** One-off CV for a single job: --overrides file.json with {title, summary, skillsFirst, groupsFirst, projectTags, bulletKeywords} */
  async custom() {
    const j = await getJob(args[0]);
    if (!j) return console.log('Not found');
    const overrides = JSON.parse(readFileSync(flags.overrides, 'utf8'));
    const meta = await customVersion(slug(`${j.company}-${j.title}`).slice(0, 40), j.cluster ?? 'default', j.id, overrides);
    await pool.query('UPDATE jobs SET cv_version = $2 WHERE id = $1', [j.id, meta.id]);
    console.log(`Custom CV: ${cvFile(meta.id)}`);
  },

  async mark() {
    const [id, status, ...note] = args;
    const allowed: JobStatus[] = ['new', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'skipped'];
    if (!(await getJob(id)) || !allowed.includes(status as JobStatus)) return console.log(`Usage: mark <id> <${allowed.join('|')}> [note]`);
    await setStatus(id, status as JobStatus, note.join(' ') || undefined);
    console.log(`${id} → ${status}`);
  },

  /** Re-renders the default CV from cv/master.json. The original PDF stays in cv/original/. */
  async 'cv:default'() {
    await renderPdf(JSON.parse(masterRaw()) as Cv, cvFile('default'));
    console.log(`default CV rebuilt from master.json → ${cvFile('default')}`);
  },

  async 'cv:build'() {
    for (const cluster of args.length ? args : Object.keys(PROFILES)) {
      const v = await versionFor(cluster);
      console.log(`${v.created ? 'built ' : 'exists'} ${v.id}  → ${cvFile(v.id)}`);
    }
  },

  async versions() {
    const { rows } = await pool.query<{ cv_version: string; n: number }>(
      'SELECT cv_version, count(*)::int n FROM jobs WHERE cv_version IS NOT NULL GROUP BY 1');
    const used = (id: string) => rows.find((r) => r.cv_version === id)?.n ?? 0;
    console.log(`default            → ${cvFile('default')}  (used for ${used('default')} jobs)`);
    for (const v of listVersions()) console.log(`${v.id.padEnd(18)} → ${cvFile(v.id)}  (used for ${used(v.id)} jobs)`);
  },

  async stats() {
    const { rows } = await pool.query<{ status: string; country: string | null; n: number }>(
      'SELECT status, country, count(*)::int n FROM jobs GROUP BY status, country ORDER BY status, country');
    for (const r of rows) console.log(`${r.status.padEnd(10)} ${(r.country ?? '--').padEnd(3)} ${r.n}`);
  },
};

const run = commands[cmd ?? ''];
if (!run) {
  console.log(`Commands:
  sponsors:update                 download Dutch IND recognised-sponsor register
  fetch [--company name]          pull jobs from company boards, filter + score
  rescore                         re-apply filters/scoring to stored jobs (after config changes)
  discover <slug...> [--add]      find a company's job board (6 ATS); --add saves hits to config.json
  list [--status new] [--country AE|SA|NL] [--min 60] [--limit 30]
  show <id> [--full]              details (+ full description)
  prepare <id> [--cv cluster]     default CV (or --cv version) + AI cover letter (--template for the plain one)
  ai:score [--id x] [--limit n]   AI fit review of matching jobs via local Claude CLI (--all to redo)
  answer <id> [--file q.txt]      AI drafts answers to pasted form questions (--clear to reset)
  custom <id> --overrides f.json  one-off CV for a single job
  add [--file job.json]           add job found in browser (JSON or stdin)
  mark <id> <status> [note]       applied | interview | offer | rejected | skipped
  cv:default                      rebuild default CV PDF from cv/master.json
  cv:build [cluster...]           pre-build CV versions
  versions                        list CV versions and usage
  stats`);
} else {
  await migrate();
  try {
    await run();
    // Any command that adds jobs or changes their status can change which copy of a job is the primary.
    if (['fetch', 'add', 'rescore', 'mark', 'prepare', 'dedupe'].includes(cmd)) {
      const n = await dedupe();
      if (n) console.log(`${n} duplicate postings grouped under their primary job.`);
    }
  } finally {
    await pool.end();
  }
}
