-- Baseline: the schema as it was before versioned migrations (the old src/schema.sql, re-run on every start).
-- Idempotent, so databases created by that file upgrade cleanly. See src/migrate.ts.

CREATE TABLE IF NOT EXISTS jobs (
  id            text PRIMARY KEY,           -- source:company:external-id
  source        text NOT NULL,              -- greenhouse | lever | ashby | bayt | linkedin | manual ...
  company       text NOT NULL,
  title         text NOT NULL,
  location      text NOT NULL DEFAULT '',
  country       text,                       -- AE | SA | NL
  url           text NOT NULL,
  description   text NOT NULL DEFAULT '',
  posted_at     timestamptz,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  score         integer NOT NULL DEFAULT 0,
  cluster       text,                       -- suggested CV version
  matched       text[] NOT NULL DEFAULT '{}',
  missing       text[] NOT NULL DEFAULT '{}',
  visa          text,
  flags         text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'new',
  filter_reason text,
  cv_version    text,
  cover_letter  text,
  applied_at    timestamptz,
  notes         text
);
CREATE INDEX IF NOT EXISTS jobs_status_score ON jobs (status, score DESC);
CREATE INDEX IF NOT EXISTS jobs_first_seen ON jobs (first_seen_at DESC);

-- Same job found on several sites (e.g. company board + LinkedIn + Bayt): the copies point at one primary
-- row and are hidden in the dashboard, which lists them as "also on". Recomputed by dedupe() in db.ts.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS duplicate_of text;
CREATE INDEX IF NOT EXISTS jobs_duplicate_of ON jobs (duplicate_of);

-- AI review of a matching job by the local Claude CLI (`bot ai:score`); keyword score stays in `score`.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_score integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_verdict text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_summary text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_reasons text[];
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_gaps text[];
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_flags text[];
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_scored_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cover_letter_ai boolean NOT NULL DEFAULT false;

-- One row per `fetch`: what was checked and what came out of it.
CREATE TABLE IF NOT EXISTS fetch_runs (
  id          serial PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checked     integer NOT NULL DEFAULT 0,
  inserted    integer NOT NULL DEFAULT 0,
  new_matches integer NOT NULL DEFAULT 0,
  errors      jsonb NOT NULL DEFAULT '[]'
);

-- Every status change (prepared, applied, interview, ...) with an optional note.
CREATE TABLE IF NOT EXISTS job_events (
  id          serial PRIMARY KEY,
  job_id      text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  from_status text,
  to_status   text NOT NULL,
  note        text
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events (job_id, at);

-- Drafted answers to application-form questions (`bot answer`), newest set last. The candidate submits them himself.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS form_answers jsonb NOT NULL DEFAULT '[]';
