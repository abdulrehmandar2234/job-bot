-- Interview prep (`bot prep <id>`) runs as a background task too: allow the `prep` kind.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_kind_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_kind_check
  CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore', 'prep'));
