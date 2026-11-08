-- Why the AI could not write the job's cover letter, when the template was used instead (`bot letter <id>`, "Write
-- letter"). The job page shows it under the letter, so a template letter is never taken for the AI's. Cleared when
-- the letter is written again.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cover_letter_ai_error text;
