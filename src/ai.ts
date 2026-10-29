import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { APPLICANT_EXAMPLE_FILE, APPLICANT_FILE, loadSettings } from './settings.ts';
import type { FormAnswer, Job } from './types.ts';
import { masterRaw } from './cv/versions.ts';
import type { Cv } from './cv/render.ts';

// AI features run through the locally signed-in Claude Code CLI (`claude -p`), so no API key is needed.
// Calls are headless: no tools, no MCP servers, no session saved.

// JOB_BOT_CLAUDE swaps in another executable (tests use a fake one).
const claudePath = () => process.env.JOB_BOT_CLAUDE || config.ai.claudePath;

export function askClaude<T>(prompt: string, schema: object, model: string, system: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(claudePath(), [
      '-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schema),
      '--system-prompt', system, '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('claude timed out')); }, 180_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const res = JSON.parse(out);
        if (res.is_error || !res.structured_output) throw new Error(res.result || `claude exited ${code}`);
        resolve(res.structured_output as T);
      } catch (e) {
        reject(new Error(`${(e as Error).message} ${err.slice(0, 300)}`.trim()));
      }
    });
    child.stdin.end(prompt);
  });
}

/** The master CV as plain text: the only facts the AI may use about the candidate. */
export function cvText(): string {
  const cv = JSON.parse(masterRaw()) as Cv;
  return [
    `${cv.name} — ${cv.title} — ${cv.contact.location}`,
    `SUMMARY: ${cv.summary}`,
    `SKILLS: ${cv.skills.map((g) => `${g.group}: ${g.items.join(', ')}`).join(' | ')}`,
    ...cv.experience.map((e) => `EXPERIENCE: ${e.role}, ${e.company} (${e.dates})\n- ${e.bullets.join('\n- ')}`),
    `PROJECTS: ${cv.projects.map((p) => `${p.name}: ${p.text}`).join(' | ')}`,
    `EDUCATION: ${cv.education.map((e) => `${e.degree}, ${e.school} (${e.dates})`).join(' | ')}`,
  ].join('\n');
}

const jobText = (job: Job) => [
  `TITLE: ${job.title}`,
  `COMPANY: ${job.company}`,
  `LOCATION: ${job.location}${job.country === 'RM' ? ' (remote; candidate would work from Pakistan)' : ''}`,
  `DESCRIPTION:\n${job.description.slice(0, 12_000)}`,
].join('\n');

export type AiScore = {
  score: number;
  verdict: 'strong' | 'good' | 'stretch' | 'poor';
  summary: string;
  reasons: string[];
  gaps: string[];
  red_flags: string[];
};

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    verdict: { type: 'string', enum: ['strong', 'good', 'stretch', 'poor'] },
    summary: { type: 'string', description: 'One sentence: should the candidate apply and why.' },
    reasons: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    gaps: { type: 'array', items: { type: 'string' }, maxItems: 4 },
    red_flags: { type: 'array', items: { type: 'string' }, maxItems: 4 },
  },
  required: ['score', 'verdict', 'summary', 'reasons', 'gaps', 'red_flags'],
};

export function aiScore(job: Job): Promise<AiScore> {
  const system = `You are a senior tech recruiter screening one job for one candidate. Judge real fit, not keyword overlap:
seniority, core stack, domain, years required, and practical blockers. The candidate lives in Lahore, Pakistan, speaks
English and Urdu only, and needs employer visa sponsorship for onsite roles (UAE, Saudi Arabia, Netherlands); remote
roles must be open to someone working from Pakistan. Put blockers in red_flags: language other than English/Urdu required,
citizens/residents only, no sponsorship, region-locked remote, clearly junior or far more senior than the candidate.
Score: 85+ strong fit, 70-84 good, 50-69 stretch, below 50 poor. Keep every string short.`;
  return askClaude<AiScore>(`CANDIDATE CV:\n${cvText()}\n\nJOB:\n${jobText(job)}`, SCORE_SCHEMA, config.ai.scoreModel, system);
}

const ANSWERS_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question as asked, cleaned up (no option lists).' },
          answer: { type: 'string', description: 'Ready to paste. For choice questions, exactly one of the given options.' },
          needs_input: { type: 'boolean', description: 'True when the answer contains a [FILL: ...] placeholder.' },
          note: { type: 'string', description: 'Short hint for the candidate, or empty.' },
        },
        required: ['question', 'answer', 'needs_input', 'note'],
      },
    },
  },
  required: ['answers'],
};

/**
 * Personal facts for forms that the CV lacks (salary, notice period...): cv/applicant.json, kept out of git.
 * Falls back to cv/applicant.example.json (all unknown). Nulls are unknown. Throws if the file is invalid.
 */
export function applicantFacts(): string {
  const file = existsSync(APPLICANT_FILE) ? APPLICANT_FILE : APPLICANT_EXAMPLE_FILE;
  const facts = { ...loadSettings('applicant', file) };
  delete facts._help;
  return JSON.stringify(facts, null, 1);
}

/** Drafts answers to pasted application-form questions. The candidate reviews and submits them himself. */
export async function aiAnswers(job: Job, questions: string): Promise<FormAnswer[]> {
  const remote = job.country === 'RM';
  const system = `You draft answers to job application form questions for one candidate, who will review and paste them himself.
The input is text copied from a form: split it into separate questions (ignore headings, "required" markers, help text).
Rules:
- Use ONLY facts from the CV and the APPLICANT FACTS. Never invent employers, numbers, skills, certifications or years.
- Personal decisions (salary, notice period, start date, nationality, working hours, how he heard about the job, anything
  not in the facts or a fact that is null) are never guessed: write [FILL: what is needed] and set needs_input true.
  Salary questions use expectedSalary for ${remote ? '"remote"' : `"${job.country}"`}.
- Yes/no and multiple-choice questions: answer with exactly one of the offered options when the facts decide it; if the
  CV does not support "yes" (e.g. years with a technology it does not show), answer honestly and explain in note.
- Years of experience: count from the CV dates; say "about N years" if unsure.
- Free-text questions ("why this company", "describe a project"): 60-150 words, specific to this job and company, first
  person, plain text, no clichés. Link the job's requirements to concrete CV experience.
- ${remote
    ? 'Remote role: he works from Lahore, Pakistan (GMT+5).'
    : 'Onsite role: he is in Lahore, Pakistan, would relocate, and needs employer visa sponsorship (answer sponsorship/right-to-work questions truthfully).'}`;
  const res = await askClaude<{ answers: FormAnswer[] }>(
    `CV:\n${cvText()}\n\nAPPLICANT FACTS (null = unknown):\n${applicantFacts()}\n\nJOB:\n${jobText(job)}\n\nFORM QUESTIONS:\n${questions.slice(0, 8000)}`,
    ANSWERS_SCHEMA, config.ai.letterModel, system);
  return res.answers;
}

export async function aiCoverLetter(job: Job): Promise<string> {
  const remote = job.country === 'RM';
  const system = `You write cover letters for one candidate. Rules:
- Use ONLY facts in the CV. Never invent employers, numbers, skills, certifications or years. If the job asks for something
  the CV lacks, do not claim it; you may show related experience or willingness to learn it in one short clause.
- Never make commitments on the candidate's behalf: working hours or time-zone overlap, salary, notice period or start
  date, assessments, background checks. Those are his to decide in the application form.
- Read the job description and connect 2-3 of its concrete requirements or products to specific CV experience.
- 200-280 words, plain text, no markdown, no placeholders like [Company], no subject line.
- Start with "Dear ${job.company} Hiring Team," and end with this exact signature block:
Best regards,
Abdul Rehman Dar
+92 321 4979646 | abdulrehmandar2234@gmail.com
https://www.linkedin.com/in/abdulrehman-dar/
- ${remote
    ? 'This is a remote role: say he is based in Lahore, Pakistan (GMT+5) and has worked remotely with international clients and distributed teams.'
    : 'This is an onsite role: say he is based in Lahore, Pakistan, ready to relocate, and would need employer visa sponsorship.'}
- Confident and specific, no clichés like "I am writing to express my interest".`;
  const res = await askClaude<{ letter: string }>(`CV:\n${cvText()}\n\nJOB:\n${jobText(job)}`,
    { type: 'object', properties: { letter: { type: 'string' } }, required: ['letter'] }, config.ai.letterModel, system);
  return res.letter.trim() + '\n';
}
