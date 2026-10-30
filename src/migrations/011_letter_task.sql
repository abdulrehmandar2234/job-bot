-- Writing the cover letter is its own background task ("Write letter" on the job page, `bot letter <id>`):
-- `prepare` only picks and builds the CV now.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter'));
