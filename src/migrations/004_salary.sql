-- Salary range of a posting (src/salary.ts, or the source's structured data). Filled by save(); `rescore` backfills.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_min integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_max integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_currency text;  -- AED | SAR | EUR | USD | GBP | PKR
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_period text;    -- year | month | hour
