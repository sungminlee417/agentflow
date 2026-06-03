-- Persistent generation job tracking.
--
-- Until now, generation progress lived only in the SSE stream of the
-- refresh request. When the user navigated away from /video-ideas
-- mid-generation, the stream died and they lost all visibility into
-- whether the run was still happening. Worse, the agent's onStep
-- callbacks would try to write to a closed controller and throw.
--
-- We persist each run as a row in video_ideas_generation_jobs. The
-- refresh route updates it on every step + on completion. The page
-- queries the latest active job for an account on load, so a user
-- coming back to /video-ideas sees the same progress card pick up
-- where the SSE left off.
--
-- Stale-job safety: any 'running' job with updated_at > 5 min in the
-- past is treated as failed by the polling endpoint (and flipped to
-- 'failed' on read). Vercel max-duration is 60s so anything stuck for
-- minutes is genuinely dead.

CREATE TABLE IF NOT EXISTS video_ideas_generation_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration_id  UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'done' | 'failed'
  step_count      INTEGER NOT NULL DEFAULT 0,
  step_label      TEXT,
  requested_count INTEGER,                          -- how many ideas we asked for
  generated_count INTEGER,                          -- set on done
  error           TEXT,                             -- set on failed
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

-- Active-job lookup hits this often (every page load on /video-ideas).
CREATE INDEX IF NOT EXISTS video_ideas_generation_jobs_active_idx
  ON video_ideas_generation_jobs (user_id, integration_id, started_at DESC)
  WHERE status = 'running';

ALTER TABLE video_ideas_generation_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_ideas_generation_jobs'
      AND policyname='video_ideas_generation_jobs_owner'
  ) THEN
    CREATE POLICY video_ideas_generation_jobs_owner
      ON video_ideas_generation_jobs
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
