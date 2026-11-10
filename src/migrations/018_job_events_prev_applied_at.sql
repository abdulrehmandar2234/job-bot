-- Every status change stamps applied_at = now() on a move to applied, so Undo could only rebuild the earlier
-- applied_at from an older "move to applied" row, and a job whose applied_at was set without one got NULL back.
-- Each status-change row now keeps the job's applied_at from just before the change; Undo restores it from there.
-- Rows written before this migration stay NULL (unknown), and Undo falls back to replaying the history for them.
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS prev_applied_at timestamptz;
