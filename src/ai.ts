import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { config } from './config.ts';
import { APPLICANT_EXAMPLE_FILE, APPLICANT_FILE, loadSettings } from './settings.ts';
import type { AiLocation, FormAnswer, InterviewPrep, Job } from './types.ts';
import { masterRaw } from './cv/versions.ts';
import type { Cv } from './cv/render.ts';

// AI features run through the locally signed-in Claude Code CLI (`claude -p`), so no API key is needed.
// Calls are headless: no tools, no MCP servers, no session saved.

// JOB_BOT_CLAUDE swaps in another executable (tests use a fake one).
const claudePath = () => process.env.JOB_BOT_CLAUDE || config.ai.claudePath;

export function askClaude<T>(prompt: string, schema: object, model: string, system: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      claudePath(),
      [
        '-p',
        '--model',
        model,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        '--system-prompt',
        system,
        '--tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-session-persistence',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('claude timed out'));
    }, 180_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
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

const jobText = (job: Job) =>
  [
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
  /** Missing from reviews made before the location check existed, and from tests' fake replies. */
  location?: { eligible: AiLocation; reason: string };
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
    location: {
      type: 'object',
      description: 'Can the candidate take this job from where they live, judged from the whole description?',
      properties: {
        eligible: { type: 'string', enum: ['yes', 'no', 'unclear'] },
        reason: { type: 'string', description: 'The phrase from the posting that decides it, quoted, or why it is unclear.' },
      },
      required: ['eligible', 'reason'],
    },
  },
  required: ['score', 'verdict', 'summary', 'reasons', 'gaps', 'red_flags', 'location'],
};

export function aiScore(job: Job): Promise<AiScore> {
  const system = `You are a senior tech recruiter screening one job for one candidate. Judge real fit, not keyword overlap:
seniority, core stack, domain, years required, and practical blockers. The candidate lives in Lahore, Pakistan, speaks
English and Urdu only, and needs employer visa sponsorship for onsite roles (UAE, Saudi Arabia, Netherlands); remote
roles must be open to someone working from Pakistan. Put blockers in red_flags: language other than English/Urdu required,
citizens/residents only, no sponsorship, region-locked remote, clearly junior or far more senior than the candidate.
Score: 85+ strong fit, 70-84 good, 50-69 stretch, below 50 poor. Keep every string short.
location: read the WHOLE description, not only the LOCATION line, for where the person must live or be allowed to
work: "must be based in / reside in X", "US/EU/UK only", "authorized to work in X without sponsorship", required time
zones or working hours far from Pakistan's (GMT+5), or a description that names another country than the LOCATION
line (for example "work remotely from Slovenia" on a Saudi Arabia listing). eligible "no" when it clearly rules the
candidate out, and also when the description says the work is done from, or the person must live in, a specific
country or region that is not Pakistan and not a target country with visa sponsorship: the description wins over the
LOCATION line. An onsite role in a target country with visa sponsorship is fine. "unclear" only when a remote job never
says where the person may live; "yes" when it is open to the candidate. Quote the deciding phrase in reason.`;
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
- ${
    remote
      ? 'Remote role: he works from Lahore, Pakistan (GMT+5).'
      : 'Onsite role: he is in Lahore, Pakistan, would relocate, and needs employer visa sponsorship (answer sponsorship/right-to-work questions truthfully).'
  }`;
  const res = await askClaude<{ answers: FormAnswer[] }>(
    `CV:\n${cvText()}\n\nAPPLICANT FACTS (null = unknown):\n${applicantFacts()}\n\nJOB:\n${jobText(job)}\n\nFORM QUESTIONS:\n${questions.slice(0, 8000)}`,
    ANSWERS_SCHEMA,
    config.ai.letterModel,
    system,
  );
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
- ${
    remote
      ? 'This is a remote role: say he is based in Lahore, Pakistan (GMT+5) and has worked remotely with international clients and distributed teams.'
      : 'This is an onsite role: say he is based in Lahore, Pakistan, ready to relocate, and would need employer visa sponsorship.'
  }
- Confident and specific, no clichés like "I am writing to express my interest".`;
  const res = await askClaude<{ letter: string }>(
    `CV:\n${cvText()}\n\nJOB:\n${jobText(job)}`,
    { type: 'object', properties: { letter: { type: 'string' } }, required: ['letter'] },
    config.ai.letterModel,
    system,
  );
  return res.letter.trim() + '\n';
}

const str = { type: 'string' };
const PREP_SCHEMA = {
  type: 'object',
  properties: {
    technical: {
      type: 'array',
      minItems: 4,
      maxItems: 8,
      items: {
        type: 'object',
        properties: { question: str, hint: { type: 'string', description: 'What to emphasise from the CV.' } },
        required: ['question', 'hint'],
      },
    },
    behavioural: {
      type: 'array',
      minItems: 3,
      maxItems: 6,
      items: {
        type: 'object',
        properties: { question: str, situation: str, task: str, action: str, result: str },
        required: ['question', 'situation', 'task', 'action', 'result'],
      },
    },
    company: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: 'What the posting itself says about the company, product and team.' },
        verify: { type: 'array', items: str, description: 'Points to verify before the interview.' },
      },
      required: ['brief', 'verify'],
    },
    questions_to_ask: { type: 'array', minItems: 3, maxItems: 8, items: str },
    requirements: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          requirement: str,
          evidence: { type: 'string', description: 'Matching CV experience, or what is missing when gap is true.' },
          gap: { type: 'boolean' },
        },
        required: ['requirement', 'evidence', 'gap'],
      },
    },
  },
  required: ['technical', 'behavioural', 'company', 'questions_to_ask', 'requirements'],
};

/** Interview prep for one job: likely questions, STAR stories, a company brief and a requirement map. */
export function aiInterviewPrep(job: Job): Promise<InterviewPrep> {
  const system = `You help one candidate prepare for a job interview. Rules:
- Use ONLY facts in the CV. Never invent employers, projects, numbers, skills, certifications or years. Never claim a skill
  or experience the CV does not show; if the job asks for it, mark that requirement as a gap and say so honestly.
- technical: questions this interviewer is likely to ask for this job's stack and level; each hint says which concrete CV
  experience to emphasise (or, for a gap, how to answer honestly).
- behavioural: common behavioural questions, each with a STAR story (situation, task, action, result) built only from CV
  facts. Never make up outcomes or numbers the CV does not state.
- company: you have NO web access and no research. Write the brief ONLY from the job description and the company name:
  product, team, stack and what they emphasise. Do not add facts about the company from memory (size, funding, founders,
  customers, news). Put anything you are unsure of, or that the candidate should check, in verify as "Verify before
  interview: ...".
- questions_to_ask: thoughtful questions the candidate can ask them, specific to this posting.
- requirements: the job's key requirements, each mapped to CV evidence, or gap true with what is missing.
- Plain text in every string, no markdown, concise.`;
  return askClaude<InterviewPrep>(`CV:\n${cvText()}\n\nJOB:\n${jobText(job)}`, PREP_SCHEMA, config.ai.letterModel, system);
}

/** A short follow-up message for an application with no answer yet. The user reviews and sends it. */
export async function aiFollowUp(job: Job, name: string | null): Promise<string> {
  const applied = job.applied_at ? new Date(job.applied_at).toISOString().slice(0, 10) : 'unknown';
  const system = `You write a short follow-up message for one candidate who applied to a job and has heard nothing back.
Rules:
- 60-120 words, plain text, no markdown, no subject line, no placeholders like [Company].
- Start with "Dear ${name ?? `${job.company} Hiring Team`}," and end with "Best regards,\nAbdul Rehman Dar".
- Say which role he applied for and roughly when, restate his interest, and connect ONE concrete requirement of the job
  to ONE specific piece of CV experience.
- Use ONLY facts in the CV. Never invent employers, numbers, skills or years.
- ${job.follow_ups > 0 ? 'He has followed up before: acknowledge it briefly and keep this one even shorter.' : 'This is his first follow-up.'}
- Polite and confident, never pushy or apologetic; no new commitments (salary, start date, hours).`;
  const res = await askClaude<{ message: string }>(
    `CV:\n${cvText()}\n\nAPPLIED ON: ${applied}\n\nJOB:\n${jobText(job)}`,
    { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    config.ai.letterModel,
    system,
  );
  return res.message.trim() + '\n';
}
