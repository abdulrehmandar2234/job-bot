-- CV templates and feedback on the generated CV.
-- jobs.cv_template: the CV design chosen for one job ("Apply template", `bot cv:template <id> <template>`); NULL =
-- config.json cvTemplate, else classic. The names are checked in code (src/cv/templates/index.ts), so adding a
-- template needs no migration. jobs.cv_review: the AI's short review of the job's CV ("Suggest improvements",
-- `bot cv:review <id>`). Task kinds: cv_template (apply a template), cv_feedback (`bot cv:feedback <id> --feedback`)
-- and cv_review.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_template text CHECK (cv_template ~ '^[a-z][a-z0-9-]*$');
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_review text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_review_at timestamptz;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter', 'summary', 'tailored_cv',
                  'cv_template', 'cv_feedback', 'cv_review'));
