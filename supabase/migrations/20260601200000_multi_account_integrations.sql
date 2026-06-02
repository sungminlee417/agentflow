-- Multi-account per provider.
--
-- Before: integrations was UNIQUE (user_id, domain, provider) — one
--   account per provider per user.
-- After:  UNIQUE (user_id, provider, provider_account_id) — multiple
--   accounts per provider, each identified by its provider-native id
--   (e.g. TikTok open_id, YouTube channel id, IG user id, GH user id).
--
-- Each integration row now also tracks:
--   • provider_account_id — opaque provider-side identifier, primary key
--   • handle             — '@username' style (user-visible)
--   • display_name       — human-readable name from the provider
--   • account_label      — user-editable nickname ("Guitar channel")
--
-- video_ideas + video_ideas_settings become per-integration so the user
-- can keep separate idea lists per account.
--
-- Backfill strategy for existing rows: set provider_account_id to a
-- sentinel 'legacy' value (one per user+provider, which the new unique
-- constraint allows since it's still distinct per row). The OAuth
-- callbacks detect this sentinel on next reconnect and upgrade it to
-- the real provider_account_id, preserving the integration row + any
-- video_ideas pointing at it.

-- 1. Add new columns to integrations.
ALTER TABLE integrations
  ADD COLUMN IF NOT EXISTS provider_account_id TEXT,
  ADD COLUMN IF NOT EXISTS handle TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS account_label TEXT;

-- 2. Backfill provider_account_id for existing rows.
UPDATE integrations
SET provider_account_id = 'legacy'
WHERE provider_account_id IS NULL;

-- 3. Lock it down + replace the old unique constraint.
ALTER TABLE integrations
  ALTER COLUMN provider_account_id SET NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'integrations'::regclass
      AND conname = 'integrations_user_id_domain_provider_key'
  ) THEN
    ALTER TABLE integrations
      DROP CONSTRAINT integrations_user_id_domain_provider_key;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'integrations'::regclass
      AND conname = 'integrations_user_provider_account_key'
  ) THEN
    ALTER TABLE integrations
      ADD CONSTRAINT integrations_user_provider_account_key
        UNIQUE (user_id, provider, provider_account_id);
  END IF;
END $$;

-- 4. Tie video_ideas to a specific integration.
ALTER TABLE video_ideas
  ADD COLUMN IF NOT EXISTS integration_id UUID
    REFERENCES integrations(id) ON DELETE CASCADE;

-- Backfill existing video_ideas: link each to the user's matching
-- provider integration (there's only one per provider before this
-- migration, so this is unambiguous).
UPDATE video_ideas vi
SET integration_id = i.id
FROM integrations i
WHERE vi.integration_id IS NULL
  AND i.user_id = vi.user_id
  AND i.provider = vi.provider;

CREATE INDEX IF NOT EXISTS video_ideas_integration_idx
  ON video_ideas (integration_id, status, expires_at);

-- 5. video_ideas_settings becomes per-integration.
ALTER TABLE video_ideas_settings
  ADD COLUMN IF NOT EXISTS integration_id UUID
    REFERENCES integrations(id) ON DELETE CASCADE;

-- Backfill: attach existing settings to user's first integration of
-- the configured provider. If there is no matching integration, leave
-- integration_id NULL and the row will be ignored (or recreated via
-- the API when the user picks an account).
UPDATE video_ideas_settings vs
SET integration_id = i.id
FROM integrations i
WHERE vs.integration_id IS NULL
  AND i.user_id = vs.user_id
  AND i.provider = vs.provider;

-- Delete any orphaned settings rows (user had no matching integration)
DELETE FROM video_ideas_settings WHERE integration_id IS NULL;

ALTER TABLE video_ideas_settings
  ALTER COLUMN integration_id SET NOT NULL;

-- Replace user_id PK with (user_id, integration_id) PK.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'video_ideas_settings'::regclass
      AND contype = 'p'
  ) THEN
    ALTER TABLE video_ideas_settings DROP CONSTRAINT video_ideas_settings_pkey;
  END IF;
END $$;

ALTER TABLE video_ideas_settings
  ADD PRIMARY KEY (user_id, integration_id);

NOTIFY pgrst, 'reload schema';
