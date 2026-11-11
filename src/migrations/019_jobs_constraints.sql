-- Guards on jobs that the code already keeps, so a bug or a hand edit cannot store a value nothing reads:
-- status is one of JobStatus (src/types.ts), salary_period one of SalaryPeriod, and duplicate_of points at a job
-- that exists (its copies become primaries again when the primary is deleted). A database with such a value is
-- cleaned first, so the constraints never stop the migration: an unknown status becomes 'new' (shown for review),
-- an unknown period drops the salary, a missing primary makes the copy a primary.
UPDATE jobs SET status = 'new'
  WHERE status NOT IN ('new', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'skipped', 'expired', 'filtered');
UPDATE jobs SET salary_min = NULL, salary_max = NULL, salary_currency = NULL, salary_period = NULL
  WHERE salary_period IS NOT NULL AND salary_period NOT IN ('year', 'month', 'hour');
UPDATE jobs j SET duplicate_of = NULL
  WHERE duplicate_of IS NOT NULL AND (duplicate_of = id OR NOT EXISTS (SELECT 1 FROM jobs p WHERE p.id = j.duplicate_of));

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('new', 'prepared', 'applied', 'interview', 'offer', 'rejected', 'skipped', 'expired', 'filtered'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_salary_period_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_salary_period_check CHECK (salary_period IN ('year', 'month', 'hour'));
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_duplicate_of_fkey;
ALTER TABLE jobs ADD CONSTRAINT jobs_duplicate_of_fkey
  FOREIGN KEY (duplicate_of) REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_not_own_duplicate;
ALTER TABLE jobs ADD CONSTRAINT jobs_not_own_duplicate CHECK (duplicate_of <> id);
