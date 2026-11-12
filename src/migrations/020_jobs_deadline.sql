-- The application deadline a posting states (src/deadline.ts), as "YYYY-MM-DD": the dashboard shows how many days
-- are left. Text, not date, so it is the same calendar day whatever the time zone of the reader.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deadline text;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_deadline_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_deadline_check CHECK (deadline ~ '^\d{4}-\d{2}-\d{2}$');
