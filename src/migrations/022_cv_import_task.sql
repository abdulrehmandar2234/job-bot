-- Importing a CV from the dashboard (`bot cv:import <file>`, Settings page) runs as a background task: allow the
-- `cv_import` kind. It has no job (job_id NULL), so the one-active-task index allows one import at a time.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up', 'letter', 'summary', 'tailored_cv',
                  'cv_template', 'cv_feedback', 'cv_review', 'headline', 'cv_import'));
