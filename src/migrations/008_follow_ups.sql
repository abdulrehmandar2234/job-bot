-- Follow-up reminders for applied jobs (src/followup.ts). The bot only drafts the message; the user sends it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_ups integer NOT NULL DEFAULT 0;   -- follow-ups the user marked as sent
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS followed_up_at timestamptz;              -- when the last one was sent
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_draft text;                    -- the latest drafted message
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS follow_up_draft_at timestamptz;

-- Drafting a follow-up runs as a background task too: allow the `follow_up` kind.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep', 'follow_up'));
