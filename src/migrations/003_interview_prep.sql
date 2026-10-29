-- Interview prep (`bot prep <id>`): the AI's questions, STAR stories, company brief and requirement map, as JSON.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS interview_prep jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS interview_prep_at timestamptz;

-- When a macOS alert went out for a `strong` AI verdict, so re-scoring a job never alerts twice.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
