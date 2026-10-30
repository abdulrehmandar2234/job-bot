-- How sure the visa note is (src/match.ts): 'offered' = the posting mentions visa/relocation support,
-- 'can-sponsor' = the company is a registered sponsor but the posting does not say, 'silent' = no mention at all,
-- 'not-needed' = remote or a country the candidate may already work in. The dashboard labels and filters on it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS visa_evidence text
  CHECK (visa_evidence IN ('offered', 'can-sponsor', 'silent', 'not-needed'));
