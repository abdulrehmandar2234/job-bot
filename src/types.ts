// Types shared by the bot (src/) and the dashboard (web/, via `import type`). Types only: no runtime code or
// imports here, so the dashboard build can erase the import and never bundles bot code.

export type JobStatus =
  | 'new' | 'prepared' | 'applied' | 'interview' | 'offer' | 'rejected' | 'skipped' | 'filtered';

/** A drafted answer to one application-form question (`bot answer`). */
export type FormAnswer = { question: string; answer: string; needs_input: boolean; note: string };

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
