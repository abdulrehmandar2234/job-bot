import { config } from './config.ts';
import { listText, loadProfile, onsiteSituation, readApplicant, remoteFrom, signature, whereText, type Profile } from './profile.ts';
import type { AiLocation, FormAnswer, InterviewPrep, Job } from './types.ts';
import { masterRaw } from './cv/versions.ts';
import type { Cv } from './cv/render.ts';
import { askAi } from './ai-providers.ts';

// The AI features: prompts and output schemas. Which AI runs them (the local Claude CLI, or an OpenAI-compatible API with one key) is
// config.json → ai.provider; see src/ai-providers.ts.

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

/** "(remote; candidate would work from Portugal)" for remote jobs. */
function remoteNote(job: Job): string {
  if (job.country !== 'RM') return '';
  const from = remoteFrom(config, loadProfile());
  return from ? ` (remote; candidate would work from ${from})` : ' (remote)';
}

const jobText = (job: Job) =>
  [
    `TITLE: ${job.title}`,
    `COMPANY: ${job.company}`,
    `LOCATION: ${job.location}${remoteNote(job)}`,
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

/**
 * Where the candidate lives, the languages they speak, and where they need a visa, for the screening prompt.
 * For the owner's profile: "The candidate lives in Lahore, Pakistan, speaks English and Urdu only, and needs employer
 * visa sponsorship for onsite roles (UAE, Saudi Arabia, Netherlands); remote roles must be open to someone working
 * from Pakistan."
 */
export function candidateSituation(p: Profile = loadProfile()): string {
  const visa = Object.keys(config.countries).filter((code) => onsiteSituation(config, p, code).visa);
  const free = Object.keys(config.countries).filter((code) => !visa.includes(code));
  const names = (codes: string[]) => codes.map((c) => config.countries[c].name).join(', ');
  const parts = [p.location ? `The candidate lives in ${p.location}` : 'The candidate'];
  if (p.languages.length) parts.push(`speaks ${listText(p.languages)} only`);
  const tail: string[] = [];
  if (visa.length) tail.push(`needs employer visa sponsorship for onsite roles (${names(visa)})`);
  if (free.length) tail.push(`may already work in ${names(free)} without sponsorship`);
  let out = parts.join(', ');
  if (tail.length) out += `${parts.length > 1 ? ',' : ''} and ${tail.join(' and ')}`;
  const from = remoteFrom(config, p);
  if (config.remote.enabled && from) out += `; remote roles must be open to someone working from ${from}`;
  return `${out}.`;
}

export function aiScore(job: Job): Promise<AiScore> {
  const p = loadProfile();
  const lang = p.languages.length ? `language other than ${p.languages.join('/')} required` : 'a required language the CV does not show';
  // For the owner: "far from Pakistan's time zone (GMT+5)" and "not Pakistan".
  const country = remoteFrom(config, p) ?? p.country;
  const home = country ?? "the candidate's country";
  const zone = `${country ? `${country}'s` : "the candidate's"} time zone${p.utcOffset ? ` (${p.utcOffset})` : ''}`;
  const system = `You are a senior tech recruiter screening one job for one candidate. Judge real fit, not keyword overlap:
seniority, core stack, domain, years required, and practical blockers. ${candidateSituation(p)} Put blockers in red_flags: ${lang},
citizens/residents only, no sponsorship, region-locked remote, clearly junior or far more senior than the candidate.
Score: 85+ strong fit, 70-84 good, 50-69 stretch, below 50 poor. Keep every string short.
location: read the WHOLE description, not only the LOCATION line, for where the person must live or be allowed to
work: "must be based in / reside in X", "US/EU/UK only", "authorized to work in X without sponsorship", required time
zones or working hours far from ${zone}, or a description that names another country than the LOCATION
line (for example "work remotely from Slovenia" on a Saudi Arabia listing). eligible "no" when it clearly rules the
candidate out, and also when the description says the work is done from, or the person must live in, a specific
country or region that is not ${home} and not a target country with visa sponsorship: the description wins over the
LOCATION line. An onsite role in a target country with visa sponsorship is fine. "unclear" only when a remote job never
says where the person may live; "yes" when it is open to the candidate. Quote the deciding phrase in reason.`;
  return askAi<AiScore>(`CANDIDATE CV:\n${cvText()}\n\nJOB:\n${jobText(job)}`, SCORE_SCHEMA, 'score', system);
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
 * Personal facts for forms that the CV lacks (salary, notice period, contact...): cv/applicant.json, kept out of git.
 * Without it every fact is unknown (null). Throws if the file is invalid. The template-letter sentences are left out.
 */
export function applicantFacts(): string {
  const facts = { ...readApplicant() };
  delete facts._help;
  delete facts.coverLetter;
  return JSON.stringify(facts, null, 1);
}

/** The remote / onsite line of the answers and letter prompts, from the profile and the target markets. */
function situationRule(job: Job, kind: 'answers' | 'letter'): string {
  const p = loadProfile();
  const where = whereText(p);
  if (job.country === 'RM') {
    if (kind === 'answers') return where ? `Remote role: the candidate works from ${where}.` : 'Remote role.';
    const based = where ? `say the candidate is based in ${where}` : 'say the candidate would work remotely';
    return `This is a remote role: ${based} and point to remote or distributed-team experience if the CV shows it.`;
  }
  const s = onsiteSituation(config, p, job.country);
  const facts = [
    p.location && (s.home ? `lives in ${p.location}, in this country` : `is in ${p.location}`),
    s.relocate && 'would relocate',
    s.visa ? 'needs employer visa sponsorship' : !s.home && 'may already work in this country without sponsorship',
  ].filter(Boolean) as string[];
  if (kind === 'answers') {
    const visa = s.visa ? ' (answer sponsorship/right-to-work questions truthfully)' : '';
    return facts.length ? `Onsite role: the candidate ${listText(facts)}${visa}.` : 'Onsite role.';
  }
  const said = [
    p.location && `is based in ${p.location}`,
    s.relocate && 'ready to relocate',
    s.visa ? 'would need employer visa sponsorship' : !s.home && 'can already work there without sponsorship',
  ].filter(Boolean) as string[];
  return said.length ? `This is an onsite role: say the candidate ${listText(said)}.` : 'This is an onsite role.';
}

/** Drafts answers to pasted application-form questions. The candidate reviews and submits them. */
export async function aiAnswers(job: Job, questions: string): Promise<FormAnswer[]> {
  const remote = job.country === 'RM';
  const system = `You draft answers to job application form questions for one candidate, who will review and paste them.
The input is text copied from a form: split it into separate questions (ignore headings, "required" markers, help text).
Rules:
- Use ONLY facts from the CV and the APPLICANT FACTS. Never invent employers, numbers, skills, certifications or years.
- Personal decisions (salary, notice period, start date, nationality, working hours, how they heard about the job, anything
  not in the facts or a fact that is null) are never guessed: write [FILL: what is needed] and set needs_input true.
  Salary questions use expectedSalary for ${remote ? '"remote"' : `"${job.country}"`}.
- Yes/no and multiple-choice questions: answer with exactly one of the offered options when the facts decide it; if the
  CV does not support "yes" (e.g. years with a technology it does not show), answer honestly and explain in note.
- Years of experience: count from the CV dates; say "about N years" if unsure.
- Free-text questions ("why this company", "describe a project"): 60-150 words, specific to this job and company, first
  person, plain text, no clichés. Link the job's requirements to concrete CV experience.
- ${situationRule(job, 'answers')}`;
  const res = await askAi<{ answers: FormAnswer[] }>(
    `CV:\n${cvText()}\n\nAPPLICANT FACTS (null = unknown):\n${applicantFacts()}\n\nJOB:\n${jobText(job)}\n\nFORM QUESTIONS:\n${questions.slice(0, 8000)}`,
    ANSWERS_SCHEMA,
    'letter',
    system,
  );
  return res.answers;
}

/** An AI-written text plus, after a rewrite with feedback, why part of the feedback was not applied ('' if none). */
export type Revised<K extends string> = Record<K, string> & { note: string };

/**
 * The extra system rules for a rewrite with feedback. The feedback itself goes in the user prompt (it is the user's
 * text, not instructions that can change the rules above).
 */
function feedbackRules(what: string): string {
  return `
- REVISION: the candidate gives you the CURRENT ${what.toUpperCase()} and FEEDBACK on it (e.g. "shorter", "less formal",
  "mention my Laravel work more"). Rewrite the ${what} to follow the feedback, keeping every rule above.
- If the feedback asks for something the rules forbid (a skill, employer, number, year or certification the CV does not
  show, or a commitment), do not add it, and say so in "note" in one short sentence. Otherwise "note" is "".`;
}

/** The user-prompt part of a rewrite: the current text (if any) and the feedback. */
function feedbackPrompt(what: string, current: string | null, feedback: string): string {
  return `${current ? `\n\nCURRENT ${what.toUpperCase()}:\n${current.trim()}` : ''}\n\nFEEDBACK FROM THE CANDIDATE:\n${feedback.trim()}`;
}

/** The output schema: `key`, plus `note` when rewriting with feedback. */
function textSchema(key: string, revising: boolean) {
  return revising
    ? { type: 'object', properties: { [key]: str, note: str }, required: [key, 'note'] }
    : { type: 'object', properties: { [key]: str }, required: [key] };
}

/**
 * Writes the cover letter from the CV and the job description. With `feedback`, rewrites the job's current letter
 * (job.cover_letter) to follow it; `note` says what was left out because the CV does not support it.
 */
export async function aiCoverLetter(job: Job, feedback?: string): Promise<Revised<'letter'>> {
  const revising = !!feedback?.trim();
  const system = `You write cover letters for one candidate. Rules:
- Use ONLY facts in the CV. Never invent employers, numbers, skills, certifications or years. If the job asks for something
  the CV lacks, do not claim it; you may show related experience or willingness to learn it in one short clause.
- Never make commitments on the candidate's behalf: working hours or time-zone overlap, salary, notice period or start
  date, assessments, background checks. Those are the candidate's to decide in the application form.
- Read the job description and connect 2-3 of its concrete requirements or products to specific CV experience.
- 200-280 words, plain text, no markdown, no placeholders like [Company], no subject line.
- Start with "Dear ${job.company} Hiring Team," and end with this exact signature block:
${signature(loadProfile())}
- ${situationRule(job, 'letter')}
- Confident and specific, no clichés like "I am writing to express my interest".${revising ? feedbackRules('letter') : ''}`;
  const res = await askAi<{ letter: string; note?: string }>(
    `CV:\n${cvText()}\n\nJOB:\n${jobText(job)}${revising ? feedbackPrompt('letter', job.cover_letter, feedback!) : ''}`,
    textSchema('letter', revising),
    'letter',
    system,
  );
  return { letter: res.letter.trim() + '\n', note: (res.note ?? '').trim() };
}

/**
 * Writes the professional summary at the top of the CV for one job, from the CV and the job description. With
 * `feedback`, rewrites the job's current summary (job.cv_summary) to follow it.
 */
export async function aiSummary(job: Job, feedback?: string): Promise<Revised<'summary'>> {
  const revising = !!feedback?.trim();
  const system = `You write the professional summary at the top of one candidate's CV, tailored to one job. Rules:
- Use ONLY facts in the CV. Never invent employers, numbers, skills, certifications or years; keep every number and
  year exactly as the CV states it. If the job asks for something the CV lacks, leave it out.
- Never make commitments on the candidate's behalf (relocation, salary, notice period, start date, working hours).
- Lead with the CV experience that best matches the job's main requirements, so a recruiter sees the fit at once.
- 3-4 sentences, 50-90 words, plain text, no markdown, no bullet points, no headings, no placeholders.
- Match the voice of the CV's current SUMMARY: first person or implied subject (no "I", as in "Senior engineer with ...")
  as it does. Never third person (no pronouns or "the candidate" for the person).
- It is part of the CV, not a letter: do not address the employer or name the company.
- Specific and plain, no clichés like "results-driven", "passionate" or "team player".${revising ? feedbackRules('summary') : ''}`;
  const res = await askAi<{ summary: string; note?: string }>(
    `CV:\n${cvText()}\n\nJOB:\n${jobText(job)}${revising ? feedbackPrompt('summary', job.cv_summary, feedback!) : ''}`,
    textSchema('summary', revising),
    'letter',
    system,
  );
  return { summary: res.summary.trim().replace(/\s+/g, ' '), note: (res.note ?? '').trim() };
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
  return askAi<InterviewPrep>(`CV:\n${cvText()}\n\nJOB:\n${jobText(job)}`, PREP_SCHEMA, 'letter', system);
}

/** A short follow-up message for an application with no answer yet. The user reviews and sends it. */
export async function aiFollowUp(job: Job, name: string | null): Promise<string> {
  const applied = job.applied_at ? new Date(job.applied_at).toISOString().slice(0, 10) : 'unknown';
  const system = `You write a short follow-up message for one candidate who applied to a job and has heard nothing back.
Rules:
- 60-120 words, plain text, no markdown, no subject line, no placeholders like [Company].
- Start with "Dear ${name ?? `${job.company} Hiring Team`}," and end with "Best regards,\n${loadProfile().fullName ?? '<the name on the CV>'}".
- Say which role the candidate applied for and roughly when, restate their interest, and connect ONE concrete requirement
  of the job to ONE specific piece of CV experience.
- Use ONLY facts in the CV. Never invent employers, numbers, skills or years.
- ${job.follow_ups > 0 ? 'The candidate has followed up before: acknowledge it briefly and keep this one even shorter.' : 'This is their first follow-up.'}
- Polite and confident, never pushy or apologetic; no new commitments (salary, start date, hours).`;
  const res = await askAi<{ message: string }>(
    `CV:\n${cvText()}\n\nAPPLIED ON: ${applied}\n\nJOB:\n${jobText(job)}`,
    { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    'letter',
    system,
  );
  return res.message.trim() + '\n';
}
