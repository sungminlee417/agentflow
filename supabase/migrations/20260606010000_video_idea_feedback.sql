-- Thumbs-down feedback on generated video ideas.
--
-- Every time the user explicitly rejects an idea, we capture WHY so
-- the next agent refresh can avoid the same failure mode. Crucially,
-- the actionable fields (title / kind / format / hook / reason /
-- free_text) are denormalised onto this row — the original
-- video_ideas row gets pruned the next time the page loads (status =
-- 'dismissed' is auto-deleted), so the FK cascade would lose the
-- signal we want to learn from. Denorm keeps the rejection lesson
-- alive past the idea's life.
--
-- Scoping is per-integration (not per-user) so a rejection on the
-- creator's music TT account doesn't poison the fitness TT account's
-- next refresh — matches the integration-scoped recentReviews +
-- find_similar_reviews patterns already in place.

CREATE TABLE IF NOT EXISTS video_idea_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration_id  UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  idea_id         UUID NOT NULL REFERENCES video_ideas(id) ON DELETE CASCADE,
  -- Denormalised idea snapshot — survives the parent idea row's
  -- deletion via dismissal-and-prune.
  idea_title      TEXT NOT NULL,
  idea_kind       TEXT NOT NULL,
  idea_format     TEXT,
  idea_hook       TEXT,
  -- One of: outdated_trend | wrong_voice | flopped_before |
  -- platform_wrong | off_brand | other. Stored as TEXT (not enum) to
  -- match the kind/status convention elsewhere in the schema.
  reason_code     TEXT NOT NULL,
  free_text       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent reads this index on every refresh to load the most recent N
-- rejections per integration.
CREATE INDEX IF NOT EXISTS video_idea_feedback_acct_idx
  ON video_idea_feedback (user_id, integration_id, created_at DESC);

ALTER TABLE video_idea_feedback ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_idea_feedback'
      AND policyname='video_idea_feedback_owner'
  ) THEN
    CREATE POLICY video_idea_feedback_owner ON video_idea_feedback
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
