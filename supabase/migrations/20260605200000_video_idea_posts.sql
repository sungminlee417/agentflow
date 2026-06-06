-- Per-platform posts for video ideas.
--
-- Until now an idea had at most one posted video — the columns
-- posted_video_id / posted_video_url / posted_at + the performance_*
-- block lived directly on video_ideas. That works for "TikTok only,
-- one post per idea" but breaks the moment the creator cross-posts
-- the same shoot to TikTok + YouTube Shorts + Instagram Reels.
--
-- video_idea_posts normalises that out. One row per (idea × platform).
-- Each row owns its own posting URL + stats + verdict + review, so
-- the system can answer "this hit on TikTok but flopped on YT" as
-- a first-class outcome.
--
-- The existing video_ideas.posted_* + performance_* columns are kept
-- as a denormalised cache of the PRIMARY post (typically the source-
-- integration post — the platform the idea was generated for). Read
-- paths that don't need per-platform breakdown can keep using them.
-- New writes go to video_idea_posts; the cache columns get refreshed
-- to reflect the earliest-posted / first-reviewed row.

CREATE TABLE IF NOT EXISTS video_idea_posts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_id             UUID NOT NULL REFERENCES video_ideas(id) ON DELETE CASCADE,
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  integration_id      UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  platform            TEXT NOT NULL,             -- 'tiktok' | 'youtube' | 'instagram'
  posted_video_id     TEXT NOT NULL,             -- provider's id (TikTok open_video_id, YT videoId, IG media id)
  posted_video_url    TEXT,
  posted_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  performance_verdict TEXT,                       -- 'hit' | 'on_track' | 'underperformed' | 'too_early'
  performance_score   NUMERIC,                    -- engagement rate
  performance_review  TEXT,                       -- markdown post-mortem
  performance_stats   JSONB,                      -- {views, likes, comments, shares, ratio, ...}
  last_reviewed_at    TIMESTAMPTZ,
  next_review_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- An idea can't have two posts on the SAME provider-side video id.
  -- (Different platforms can share an id namespace freely.)
  UNIQUE (idea_id, platform, posted_video_id)
);

CREATE INDEX IF NOT EXISTS video_idea_posts_idea_idx
  ON video_idea_posts (idea_id);
CREATE INDEX IF NOT EXISTS video_idea_posts_user_platform_idx
  ON video_idea_posts (user_id, platform);
-- Worker polls this — partial index on rows with a scheduled review.
CREATE INDEX IF NOT EXISTS video_idea_posts_review_due_idx
  ON video_idea_posts (next_review_at)
  WHERE next_review_at IS NOT NULL;

ALTER TABLE video_idea_posts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_idea_posts'
      AND policyname='video_idea_posts_owner'
  ) THEN
    CREATE POLICY video_idea_posts_owner ON video_idea_posts
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- Backfill: every idea that has a posted_video_id today becomes a
-- single post row on its source integration's platform. Idempotent
-- via the UNIQUE constraint.
INSERT INTO video_idea_posts (
  idea_id, user_id, integration_id, platform,
  posted_video_id, posted_video_url, posted_at,
  performance_verdict, performance_score, performance_review,
  performance_stats, last_reviewed_at, next_review_at
)
SELECT
  vi.id,
  vi.user_id,
  vi.integration_id,
  vi.provider,
  vi.posted_video_id,
  vi.posted_video_url,
  COALESCE(vi.posted_at, NOW()),
  vi.performance_verdict,
  vi.performance_score,
  vi.performance_review,
  vi.performance_stats,
  vi.last_reviewed_at,
  vi.next_review_at
FROM video_ideas vi
WHERE vi.posted_video_id IS NOT NULL
ON CONFLICT (idea_id, platform, posted_video_id) DO NOTHING;

NOTIFY pgrst, 'reload schema';
