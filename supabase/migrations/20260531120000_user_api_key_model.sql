-- Per-key model selection.
--
-- Each provider key now optionally remembers which model to use.
-- When null, the agent falls back to the provider's default (see
-- DEFAULT_MODELS in packages/core/src/ai-providers.ts). This lets a
-- user pick e.g. claude-haiku-4-5 (much higher rate limits) without
-- changing their API key.

ALTER TABLE user_api_keys
  ADD COLUMN IF NOT EXISTS model TEXT;

NOTIFY pgrst, 'reload schema';
