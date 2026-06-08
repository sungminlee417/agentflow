import type { SupabaseClient } from "@supabase/supabase-js";

// Resolve an OAuth app's client_id + client_secret for a given user
// and provider. Reads from server env vars only — agentflow ships a
// single shared OAuth app per provider so individual users don't need
// to register their own developer account.
//
// The `supabase` + `userId` parameters are kept so existing callsites
// keep compiling and so the signature stays open for a future
// per-user override (if a power user ever needs higher rate limits
// than the shared app gives).
//
// Returns null if env vars aren't set — that path produces a clean
// "oauth_app_not_configured" redirect on the integrations page.

export type OAuthProvider = "youtube" | "tiktok" | "instagram";

const ENV_KEYS: Record<
  OAuthProvider,
  { idVar: string; secretVar: string }
> = {
  youtube: {
    idVar: "GOOGLE_OAUTH_CLIENT_ID",
    secretVar: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
  tiktok: {
    idVar: "TIKTOK_OAUTH_CLIENT_KEY",
    secretVar: "TIKTOK_OAUTH_CLIENT_SECRET",
  },
  instagram: {
    idVar: "INSTAGRAM_APP_ID",
    secretVar: "INSTAGRAM_APP_SECRET",
  },
};

export type OAuthCredentials = {
  client_id: string;
  client_secret: string;
  source: "env";
};

export async function getOAuthCredentials(
  _supabase: SupabaseClient,
  _userId: string,
  provider: OAuthProvider,
): Promise<OAuthCredentials | null> {
  const env = ENV_KEYS[provider];
  const id = process.env[env.idVar];
  const secret = process.env[env.secretVar];
  if (id && secret) {
    return { client_id: id, client_secret: secret, source: "env" };
  }
  return null;
}
