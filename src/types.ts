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
  salary_min: number | null;      // salary range (src/salary.ts or the source's own data), in salary_currency
  salary_max: number | null;
  salary_currency: SalaryCurrency | null;
  salary_period: SalaryPeriod | null;
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

/** One row of `job_events`: a status change. */
export type JobEvent = { id: number; at: Date; from_status: string | null; to_status: string; note: string | null };

/** One row of `fetch_runs` (the dashboard reads the fields below). */
export type FetchRun = { started_at: Date; finished_at: Date | null; checked: number; inserted: number; new_matches: number };
