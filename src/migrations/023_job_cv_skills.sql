-- Job skills the candidate confirmed with "I have this" for this one job (cv:feedback --add-skills). Only this job's
-- CVs, keyword check and AI texts may show them; cv/master.json and every other job's matching stay as they are.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cv_skills text[] NOT NULL DEFAULT '{}';
