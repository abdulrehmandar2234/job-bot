-- Dead-link check (`bot check:open`): when a posting was last confirmed open or closed, and when it was found closed
-- (the job then moves to status `expired`).
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS checked_open_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS closed_at timestamptz;
