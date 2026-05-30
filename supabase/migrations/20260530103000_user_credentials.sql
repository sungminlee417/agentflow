-- User credentials: BYOK API keys + encrypted OAuth tokens.
--
-- Two surfaces:
--   • user_api_keys — keys the user pastes (Anthropic, OpenAI, ...)
--   • integrations — OAuth tokens for connected platforms (YouTube,
--     TikTok, Instagram, ...). The table already exists from the init
--     migration with plain-text access_token / refresh_token columns;
--     this migration swaps them for encrypted-at-rest equivalents.
--
-- Encryption is application-level (AES-256-GCM via node:crypto) using
-- the master key in the AGENTFLOW_SECRET_KEY env var, which lives on
-- the worker and Next.js server runtime — never the browser. Stored
-- format is "v1:<base64-iv>:<base64-ciphertext-and-tag>"; the v1
-- prefix lets us rotate algorithm/key later without a schema change.
-- The DB sees opaque text and cannot decrypt it on its own.

-- user_api_keys -----------------------------------------------------

CREATE TABLE IF NOT EXISTS user_api_keys (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,  -- 'anthropic', 'openai', ...
  encrypted_key  TEXT NOT NULL,
  key_last4      TEXT NOT NULL,  -- display hint: "...AB12"
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS user_api_keys_user_idx
  ON user_api_keys (user_id);

ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_api_keys'
      AND policyname='user_api_keys_owner'
  ) THEN
    CREATE POLICY user_api_keys_owner ON user_api_keys
      FOR ALL TO authenticated
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;

-- integrations: swap plain-text tokens for encrypted columns --------

ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS encrypted_access_token  TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_refresh_token TEXT;

ALTER TABLE integrations
  DROP COLUMN IF EXISTS access_token,
  DROP COLUMN IF EXISTS refresh_token;

NOTIFY pgrst, 'reload schema';
