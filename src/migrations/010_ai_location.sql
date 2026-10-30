-- The AI review's location check (src/ai.ts aiScore): can a candidate living in the profile's country take this
-- job, judged from the whole description, not just the location field? 'no' keeps a job filtered across re-scores.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_location text CHECK (ai_location IN ('yes', 'no', 'unclear'));
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ai_location_reason text;
