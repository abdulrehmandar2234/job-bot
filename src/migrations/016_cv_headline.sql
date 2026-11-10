-- A CV headline written for one job ("CV headline for this job" on the job page, `bot headline <id>`): the line under
-- the name on the CV. `cv:tailor <id>` builds a CV with it and the job's CV summary. *_edited_at: the user edited it
-- by hand on the job page; the bot clears it when it writes the headline again.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_headline text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_headline_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_headline_edited_at timestamptz;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter', 'summary', 'tailored_cv',
                  'cv_template', 'cv_feedback', 'cv_review', 'headline'));
