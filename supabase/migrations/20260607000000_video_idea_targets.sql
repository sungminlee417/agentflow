-- Multi-target ideas. Replaces the single-source video_ideas.integration_id
-- as the authoritative "which accounts this idea is for" — but keeps
-- video_ideas.integration_id populated as the PRIMARY target for back-compat
-- (read paths that don't need multi-target awareness keep working unchanged).
--
-- Why a join table not an array column on video_ideas:
--   - Lets "every idea targeting account X" be an index seek, not array
--     containment scan. The /video-ideas page filters this way constantly.
--   - Allows future per-target metadata (per-account priority, per-account
--     dismissal) without column churn on video_ideas.
--   - FK CASCADE cleans up when an integration is disconnected.
--
-- user_id is denormalised onto the join row so RLS doesn't traverse —
-- same pattern as video_idea_posts.

CREATE TABLE IF NOT EXISTS video_idea_targets (
  idea_id         UUID NOT NULL REFERENCES video_ideas(id) ON DELETE CASCADE,
  integration_id  UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Mirrors video_ideas.integration_id for back-compat. Exactly one
  -- per idea (enforced by partial unique index below).
  is_primary      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (idea_id, integration_id)
);

CREATE INDEX IF NOT EXISTS video_idea_targets_integration_idx
  ON video_idea_targets (integration_id, idea_id);
CREATE INDEX IF NOT EXISTS video_idea_targets_user_idx
  ON video_idea_targets (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS video_idea_targets_one_primary_idx
  ON video_idea_targets (idea_id) WHERE is_primary;

ALTER TABLE video_idea_targets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_idea_targets' AND policyname='video_idea_targets_owner'
  ) THEN
    CREATE POLICY video_idea_targets_owner ON video_idea_targets
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Backfill: every existing idea row gets exactly one target row matching
-- its current integration_id, marked primary. Idempotent via PK.
INSERT INTO video_idea_targets (idea_id, integration_id, user_id, is_primary)
SELECT id, integration_id, user_id, TRUE
FROM video_ideas
WHERE integration_id IS NOT NULL
ON CONFLICT (idea_id, integration_id) DO NOTHING;

-- The generation-jobs table needs multi-account awareness so the new
-- /api/video-ideas/generate route can record "this job covers accounts
-- [A,B,C]" and the concurrency guard can reject overlapping per-account
-- /refresh runs.
ALTER TABLE video_ideas_generation_jobs
  ALTER COLUMN integration_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS integration_ids UUID[] NOT NULL DEFAULT '{}';

UPDATE video_ideas_generation_jobs
SET integration_ids = ARRAY[integration_id]
WHERE integration_id IS NOT NULL AND cardinality(integration_ids) = 0;

CREATE INDEX IF NOT EXISTS video_ideas_generation_jobs_intids_idx
  ON video_ideas_generation_jobs USING GIN (integration_ids);

NOTIFY pgrst, 'reload schema';
