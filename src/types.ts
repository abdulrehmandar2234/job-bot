// Types, and a few constant lists, shared by the bot (src/) and the dashboard (web/). No imports and no I/O, so any
// part of the dashboard can import it, client components included.

// workday: token is "<tenant>/<wdN>/<site>", e.g. "acme/wd3/AcmeCareers".
export const ATS = ['greenhouse', 'lever', 'ashby', 'recruitee', 'workable', 'smartrecruiters', 'workday', 'personio'] as const;

// The remote job boards the bot can fetch (BOARDS in src/sources/boards.ts).
/** Kinds of job the `skipJobTypes` setting can filter out, as a source states them (LinkedIn's job criteria, freehire). */
export const JOB_TYPES = ['internship', 'part-time', 'temporary', 'contract', 'volunteer'] as const;
/** What `skipJobTypes` is when config.json leaves it out. */
export const DEFAULT_SKIP_JOB_TYPES: readonly (typeof JOB_TYPES)[number][] = ['internship', 'part-time', 'temporary', 'volunteer'];
export const REMOTE_BOARDS = ['himalayas', 'remotive', 'remoteok', 'arbeitnow', 'adzuna', 'jobicy', 'hackernews', 'freehire'] as const;

/** A CV version name (`default`, `laravel-v1`): the one rule for every path and task argument that takes one. */
export const CV_VERSION = /^[a-z0-9][a-z0-9-]*$/;

/** Longest feedback for rewriting a letter, summary or CV ("What should change?" on the job page). */
export const FEEDBACK_CAP = 1000;

/** Done and failed tasks are deleted this long after they finished (when the next task is queued). */
export const KEEP_FINISHED_DAYS = 30;

/** When the scheduled daily run starts if config.json has no `dailyTime` (src/commands/daily.ts). */
export const DEFAULT_DAILY_TIME = '09:00';

export type JobStatus = 'new' | 'prepared' | 'applied' | 'interview' | 'offer' | 'rejected' | 'skipped' | 'expired' | 'filtered';

/** The AI review's location check: 'no' means the description rules the candidate out (region, residency, work permit). */
export type AiLocation = 'yes' | 'no' | 'unclear';

/**
 * How sure the visa note is: 'offered' = the posting mentions visa/relocation support, 'can-sponsor' = the company
 * is a registered sponsor but the posting does not say, 'silent' = no mention, 'not-needed' = remote or home country.
 */
export type VisaEvidence = 'offered' | 'can-sponsor' | 'silent' | 'not-needed';

/** A drafted answer to one application-form question (`bot answer`). */
export type FormAnswer = { question: string; answer: string; needs_input: boolean; note: string };

/** Interview prep for one job (`bot prep`), drawn only from the job description and cv/master.json. */
export type InterviewPrep = {
  technical: { question: string; hint: string }[]; // hint: what to emphasise from the CV
  behavioural: { question: string; situation: string; task: string; action: string; result: string }[]; // STAR, CV facts only
  company: { brief: string; verify: string[] }; // from the posting and company name only; verify = unsure points
  questions_to_ask: string[];
  requirements: { requirement: string; evidence: string; gap: boolean }[]; // evidence from the CV, or why it is a gap
};

/** One row of the `jobs` table (src/migrations). */
export type Job = {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  country: string | null;
  url: string;
  description: string;
  posted_at: Date | null;
  first_seen_at: Date;
  fetched_at: Date;
  score: number;
  cluster: string | null;
  matched: string[];
  missing: string[];
  visa: string | null; // why we think visa is possible
  visa_evidence: VisaEvidence | null; // how sure that is (src/match.ts)
  flags: string[]; // warnings
  status: JobStatus;
  filter_reason: string | null;
  cv_version: string | null;
  cover_letter: string | null;
  cover_letter_ai: boolean;
  cover_letter_edited_at: Date | null; // the user edited the letter by hand on the job page
  cover_letter_ai_error: string | null; // why the AI failed, when the letter is the template instead
  cv_summary: string | null; // the CV summary the AI wrote for this job (`bot summary`)
  cv_summary_at: Date | null;
  cv_summary_edited_at: Date | null; // the user edited the summary by hand on the job page
  cv_headline: string | null; // the CV headline the AI wrote for this job (`bot headline`)
  cv_headline_at: Date | null;
  cv_headline_edited_at: Date | null; // the user edited the headline by hand on the job page
  cv_template: string | null; // the CV design chosen for this job (src/cv/templates); null = config.json cvTemplate
  cv_review: string | null; // the AI's short review of this job's CV (`bot cv:review`)
  cv_review_at: Date | null;
  applied_at: Date | null;
  notes: string | null;
  duplicate_of: string | null;
  ai_score: number | null;
  ai_verdict: string | null;
  ai_summary: string | null;
  ai_reasons: string[] | null;
  ai_gaps: string[] | null;
  ai_flags: string[] | null;
  ai_scored_at: Date | null;
  ai_location: AiLocation | null; // AI review: can the candidate take the job from where they live?
  ai_location_reason: string | null; // the phrase that decided it
  form_answers: FormAnswer[];
  interview_prep: InterviewPrep | null;
  interview_prep_at: Date | null;
  alerted_at: Date | null; // macOS alert sent for a `strong` AI verdict (once per job)
  salary_min: number | null; // salary range (src/salary.ts or the source's own data), in salary_currency
  salary_max: number | null;
  salary_currency: SalaryCurrency | null;
  salary_period: SalaryPeriod | null;
  checked_open_at: Date | null; // last time `check:open` got a clear open/closed answer
  closed_at: Date | null; // when the posting was found closed (status `expired`)
  deadline: string | null; // application deadline the posting states, "YYYY-MM-DD" (src/deadline.ts)
  follow_ups: number; // follow-ups the user marked as sent (src/followup.ts)
  followed_up_at: Date | null;
  follow_up_draft: string | null; // the latest drafted follow-up message
  follow_up_draft_at: Date | null;
};

/** A posting as a source adapter returns it, before scoring. */
export type RawJob = {
  id: string;
  source: string;
  company: string;
  title: string;
  location: string;
  url: string;
  description: string;
  posted_at: string | null;
  salary?: Salary | null; // structured salary from the source's API; else save() parses the description
  seen?: boolean; // false: scored again from the database (rescore), not seen by a fetch, so fetched_at stays
};

/** An ISO 4217 code from src/currencies.json ("INR", "EUR"); see src/currencies.ts. */
export type SalaryCurrency = string;
export type SalaryPeriod = 'year' | 'month' | 'hour';
/** A salary range. One end may be open ("up to AED 25k": min null). */
export type Salary = { min: number | null; max: number | null; currency: SalaryCurrency; period: SalaryPeriod };

/** Why the user skipped a job (optional, picked next to the Skip button). `location` covers visa too. */
export const SKIP_REASONS = ['stack', 'seniority', 'salary', 'location', 'company', 'language', 'other'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** One row of `job_events`: a status change. `reason` is only set on skips. */
export type JobEvent = {
  id: number;
  at: Date;
  from_status: string | null;
  to_status: string;
  note: string | null;
  reason: SkipReason | null;
  /** The job's applied_at just before this row (migration 018); NULL on rows written before it, or when it was unset. */
  prev_applied_at: Date | null;
};

export type ContactRole = 'recruiter' | 'hiring manager' | 'referral' | 'other';
export type ReferralStatus = 'none' | 'to ask' | 'asked' | 'agreed' | 'referred';

/** One row of `contacts`: a person the user knows for a job. Only what the user typed; nobody is contacted. */
export type Contact = {
  id: number;
  job_id: string;
  name: string;
  role: ContactRole;
  email: string | null;
  linkedin_url: string | null;
  phone: string | null;
  notes: string | null;
  referral_status: ReferralStatus;
  created_at: Date;
};

/** One row of `fetch_runs` (the dashboard reads the fields below). */
export type FetchRun = { started_at: Date; finished_at: Date | null; checked: number; inserted: number; new_matches: number };

/** A background task kind: what `task:run` runs (src/tasks.ts). */
export type TaskKind =
  | 'fetch'
  | 'prepare'
  | 'ai_review'
  | 'answers'
  | 'rescore'
  | 'prep'
  | 'follow_up'
  | 'letter'
  | 'summary'
  | 'tailored_cv'
  | 'cv_template'
  | 'cv_feedback'
  | 'cv_review'
  | 'headline';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

/** One row of `tasks`. `args` holds the command's options, e.g. { cv, force } for prepare, { questions } for answers, { feedback } for letter, summary, headline and cv_feedback, or { template } for cv_template. */
export type Task = {
  id: number;
  kind: TaskKind;
  job_id: string | null;
  args: Record<string, string>;
  status: TaskStatus;
  output: string | null;
  error: string | null;
  pid: number | null;
  dismissed: boolean;
  created_at: Date;
  started_at: Date | null;
  deadline: Date | null;
  finished_at: Date | null;
};
