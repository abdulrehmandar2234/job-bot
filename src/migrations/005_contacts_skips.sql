-- Contacts per job (recruiters, hiring managers, referrals) that the user typed in. The bot never contacts anyone.
CREATE TABLE IF NOT EXISTS contacts (
  id              serial PRIMARY KEY,
  job_id          text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name            text NOT NULL,
  role            text NOT NULL DEFAULT 'other'
                  CHECK (role IN ('recruiter', 'hiring manager', 'referral', 'other')),
  email           text,
  linkedin_url    text,
  phone           text,
  notes           text,
  referral_status text NOT NULL DEFAULT 'none'
                  CHECK (referral_status IN ('none', 'to ask', 'asked', 'agreed', 'referred')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_job ON contacts (job_id);

-- Why a job was skipped (optional), to learn which titles roleExclude should drop. Set with the status change.
ALTER TABLE job_events ADD COLUMN IF NOT EXISTS reason text
  CHECK (reason IN ('stack', 'seniority', 'salary', 'location', 'company', 'language', 'other'));
