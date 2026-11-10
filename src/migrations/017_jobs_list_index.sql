-- The main job list (web/lib/db.ts) and the ai:score queue read primaries of one status, best AI score first:
-- `duplicate_of IS NULL AND status = $1 ORDER BY ai_score DESC NULLS LAST, score DESC`. jobs_status_score
-- (status, score DESC) cannot give that order, so every list page sorted the whole status. tests/migrate.test.ts
-- checks that the planner uses this index.
CREATE INDEX IF NOT EXISTS jobs_list_idx ON jobs (status, ai_score DESC NULLS LAST, score DESC) WHERE duplicate_of IS NULL;
