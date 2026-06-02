-- Always-on video ideas surface.
--
-- Two tables:
--   • video_ideas — the visible list. Each row is one concrete idea
--     with an expires_at so stale/trend-bound ideas drop off without
--     polluting the page. status drives card UI (pending/scheduled/
--     done/dismissed). kind drives expiry math + which generator
--     produced it.
--   • discovered_competitors — cached set of niche peers the agent
--     auto-discovers via Apify (hashtag search → dedupe authors).
--     Cached so we don't re-discover on every refresh (refreshed_at
--     gates re-discovery to ~weekly).
--
-- Why no settings table: target_count is small + per-user, so we
-- store it on a one-row video_ideas_settings table keyed by user_id.

CREATE TABLE IF NOT EXISTS video_ideas (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,            -- 'tiktok' for now
  title        TEXT NOT NULL,
  hook         TEXT,                     -- one-line opening hook
  format       TEXT,                     -- e.g. "acoustic vs classical comparison"
  rationale    TEXT,                     -- why this should work
  kind         TEXT NOT NULL,            -- 'pattern' | 'trend' | 'competitor' | 'seasonal'
  source_refs  JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at   TIMESTAMPTZ NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'scheduled' | 'done' | 'dismissed'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS video_ideas_user_status_idx
  ON video_ideas (user_id, status, expires_at);

ALTER TABLE video_ideas ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_ideas' AND policyname='video_ideas_owner'
  ) THEN
    CREATE POLICY video_ideas_owner ON video_ideas
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS discovered_competitors (
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  handle           TEXT NOT NULL,
  avg_engagement   NUMERIC,
  shared_hashtags  TEXT[] NOT NULL DEFAULT '{}',
  refreshed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider, handle)
);

ALTER TABLE discovered_competitors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='discovered_competitors' AND policyname='discovered_competitors_owner'
  ) THEN
    CREATE POLICY discovered_competitors_owner ON discovered_competitors
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS video_ideas_settings (
  user_id       UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL DEFAULT 'tiktok',
  target_count  INTEGER NOT NULL DEFAULT 10,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE video_ideas_settings ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='video_ideas_settings' AND policyname='video_ideas_settings_owner'
  ) THEN
    CREATE POLICY video_ideas_settings_owner ON video_ideas_settings
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
