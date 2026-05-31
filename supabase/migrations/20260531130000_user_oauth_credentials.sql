-- Per-user OAuth app credentials (BYOK for OAuth).
--
-- Each user can register their own OAuth app per provider (e.g. their
-- own GitHub OAuth App, their own TikTok app, their own Meta app).
-- The agent's OAuth flow uses THE USER'S app credentials when present,
-- falling back to server env vars for single-user dev convenience.
--
-- Why per-user: for TikTok and Instagram especially, only accounts
-- added as testers on the OAuth app can connect outside of full
-- app review. So each user must run their own app to use their own
-- account without going through Meta/TikTok's review processes.
--
-- Credentials are encrypted at rest with AGENTFLOW_SECRET_KEY, same
-- pattern as user_api_keys and integrations.

CREATE TABLE IF NOT EXISTS user_oauth_credentials (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider                 TEXT NOT NULL,  -- 'github' | 'youtube' | 'tiktok' | 'instagram'
  encrypted_client_id      TEXT NOT NULL,
  encrypted_client_secret  TEXT NOT NULL,
  client_id_last4          TEXT NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS user_oauth_credentials_user_idx
  ON user_oauth_credentials (user_id);

ALTER TABLE user_oauth_credentials ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public'
      AND tablename='user_oauth_credentials'
      AND policyname='user_oauth_credentials_owner'
  ) THEN
    CREATE POLICY user_oauth_credentials_owner ON user_oauth_credentials
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
