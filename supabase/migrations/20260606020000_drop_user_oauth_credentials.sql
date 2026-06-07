-- Drop the user_oauth_credentials table.
--
-- agentflow moved to a single shared OAuth app per provider (server
-- env vars). The "bring-your-own OAuth app" path is gone — the UI
-- expander, the /api/oauth-credentials API route, and the per-user
-- fallback in getOAuthCredentials have all been removed.
--
-- Safe to drop: the only consumer (getOAuthCredentials) no longer
-- reads from it, and the integrations page query no longer joins
-- against it. ON DELETE CASCADE means existing connection rows
-- (integrations) are unaffected.

DROP TABLE IF EXISTS user_oauth_credentials;

NOTIFY pgrst, 'reload schema';
