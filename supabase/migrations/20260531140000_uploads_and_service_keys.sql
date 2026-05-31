-- Two new surfaces to extend what the agent can see:
--
-- 1. creator_analytics_uploads — the user uploads CSV/text exports
--    from creator dashboards (TikTok Studio, YouTube Studio, IG
--    Insights). API can't expose retention curves / traffic sources,
--    so this is how the agent gets that data for real coaching.
--
-- 2. user_service_keys — BYOK for third-party data services (currently
--    Apify, for TikTok niche/competitor scraping). Same encryption
--    pattern as user_api_keys.

CREATE TABLE IF NOT EXISTS creator_analytics_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,  -- 'tiktok' | 'youtube' | 'instagram'
  label        TEXT NOT NULL,  -- "Overview Aug 2026", "Per-video stats", etc.
  filename     TEXT,
  content_type TEXT,           -- 'text/csv' | 'application/json' | etc.
  content_text TEXT NOT NULL,  -- raw parsed text (LLMs can read CSV directly)
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS creator_analytics_uploads_user_idx
  ON creator_analytics_uploads (user_id, provider, created_at DESC);

ALTER TABLE creator_analytics_uploads ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='creator_analytics_uploads'
      AND policyname='creator_analytics_uploads_owner'
  ) THEN
    CREATE POLICY creator_analytics_uploads_owner ON creator_analytics_uploads
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS user_service_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service        TEXT NOT NULL,  -- 'apify'
  encrypted_key  TEXT NOT NULL,
  key_last4      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, service)
);

CREATE INDEX IF NOT EXISTS user_service_keys_user_idx
  ON user_service_keys (user_id);

ALTER TABLE user_service_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='user_service_keys'
      AND policyname='user_service_keys_owner'
  ) THEN
    CREATE POLICY user_service_keys_owner ON user_service_keys
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
