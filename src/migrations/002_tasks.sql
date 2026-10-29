-- Background tasks: long operations (fetch, prepare, AI review, draft answers, rescore) started from the dashboard.
-- The dashboard inserts a row and spawns a detached `bot task:run <id>`, which claims the row, runs the command
-- and records the result. See src/tasks.ts and web/lib/tasks.ts.
CREATE TABLE IF NOT EXISTS tasks (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('fetch', 'prepare', 'ai_review', 'answers', 'rescore')),
  job_id      text REFERENCES jobs (id) ON DELETE CASCADE,
  args        jsonb NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  output      text,                         -- tail of the command's output, capped
  error       text,
  pid         integer,                      -- the worker process, for debugging
  dismissed   boolean NOT NULL DEFAULT false, -- a failure the user has seen and closed
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  deadline    timestamptz,                  -- set when claimed: started_at + the kind's timeout + grace
  finished_at timestamptz
);

-- The duplicate guard: one queued/running task per kind (fetch, rescore) or per (kind, job). Enqueue uses
-- INSERT ... ON CONFLICT DO NOTHING on this index, so two clicks can never start the same work twice.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active ON tasks (kind, coalesce(job_id, ''))
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS tasks_job ON tasks (job_id);
-- What the dashboard shows: active tasks and failures not yet dismissed.
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (created_at)
  WHERE status IN ('queued', 'running') OR (status = 'failed' AND NOT dismissed);

-- Fails tasks whose worker is gone (process killed, Mac restarted), so they never block new ones:
-- a running task past its deadline, or a queued task no worker claimed within 2 minutes.
-- Called by both the bot and the dashboard before enqueueing and when listing; returns how many it failed.
CREATE OR REPLACE FUNCTION expire_stale_tasks() RETURNS integer LANGUAGE sql AS $$
  WITH expired AS (
    UPDATE tasks SET status = 'failed', finished_at = now(),
      error = CASE WHEN status = 'queued'
        THEN 'The worker never started (see data/logs/tasks.log).'
        ELSE 'Timed out: the worker stopped (killed, or the Mac slept or restarted).' END
    WHERE (status = 'running' AND deadline < now())
       OR (status = 'queued' AND created_at < now() - interval '2 minutes')
    RETURNING 1)
  SELECT count(*)::int FROM expired
$$;
