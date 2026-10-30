-- A CV summary written for one job ("CV summary for this job" on the job page, `bot summary <id>`), and a one-off
-- CV version built with it (`bot cv:tailor <id>`, task kind tailored_cv). The *_edited_at columns record that the
-- user edited the text by hand on the job page; the bot clears them when it writes the text again.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_summary text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_summary_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_summary_edited_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cover_letter_edited_at timestamptz;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter', 'summary', 'tailored_cv'));
