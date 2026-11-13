-- What the letter check (src/ai.ts aiCheckLetter) fixed in the AI letter before it was stored: one sentence per
-- problem. NULL = not checked (template letter, check off or failed), empty = checked and nothing to fix.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cover_letter_check text[];
