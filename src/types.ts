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
};

/** One row of `job_events`: a status change. */
export type JobEvent = { id: number; at: Date; from_status: string | null; to_status: string; note: string | null };

/** One row of `fetch_runs` (the dashboard reads the fields below). */
export type FetchRun = { started_at: Date; finished_at: Date | null; checked: number; inserted: number; new_matches: number };
