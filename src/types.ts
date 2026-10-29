// Types shared by the bot (src/) and the dashboard (web/, via `import type`). Types only: no runtime code or
// imports here, so the dashboard build can erase the import and never bundles bot code.

export type JobStatus =
  | 'new' | 'prepared' | 'applied' | 'interview' | 'offer' | 'rejected' | 'skipped' | 'expired' | 'filtered';

/** A drafted answer to one application-form question (`bot answer`). */
export type FormAnswer = { question: string; answer: string; needs_input: boolean; note: string };

/** Interview prep for one job (`bot prep`), drawn only from the job description and cv/master.json. */
export type InterviewPrep = {
  technical: { question: string; hint: string }[];  // hint: what to emphasise from the CV
  behavioural: { question: string; situation: string; task: string; action: string; result: string }[]; // STAR, CV facts only
  company: { brief: string; verify: string[] };     // from the posting and company name only; verify = unsure points
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
  visa: string | null;   // why we think visa is possible
  flags: string[];       // warnings
  status: JobStatus;
  filter_reason: string | null;
  cv_version: string | null;
  cover_letter: string | null;
  cover_letter_ai: boolean;
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
  form_answers: FormAnswer[];
  interview_prep: InterviewPrep | null;
  interview_prep_at: Date | null;
  alerted_at: Date | null; // macOS alert sent for a `strong` AI verdict (once per job)
  salary_min: number | null;      // salary range (src/salary.ts or the source's own data), in salary_currency
  salary_max: number | null;
  salary_currency: SalaryCurrency | null;
  salary_period: SalaryPeriod | null;
  checked_open_at: Date | null; // last time `check:open` got a clear open/closed answer
  closed_at: Date | null;       // when the posting was found closed (status `expired`)
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
  salary?: Salary | null;  // structured salary from the source's API; else save() parses the description
};

export type SalaryCurrency = 'AED' | 'SAR' | 'EUR' | 'USD' | 'GBP' | 'PKR';
export type SalaryPeriod = 'year' | 'month' | 'hour';
/** A salary range. One end may be open ("up to AED 25k": min null). */
export type Salary = { min: number | null; max: number | null; currency: SalaryCurrency; period: SalaryPeriod };

/** Why the user skipped a job (optional, picked next to the Skip button). `location` covers visa too. */
export type SkipReason = 'stack' | 'seniority' | 'salary' | 'location' | 'company' | 'language' | 'other';

/** One row of `job_events`: a status change. `reason` is only set on skips. */
export type JobEvent = {
  id: number; at: Date; from_status: string | null; to_status: string; note: string | null; reason: SkipReason | null;
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
export type TaskKind = 'fetch' | 'prepare' | 'ai_review' | 'answers' | 'rescore';
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed';

/** One row of `tasks`. `args` holds the command's options, e.g. { cv } for prepare or { questions } for answers. */
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
