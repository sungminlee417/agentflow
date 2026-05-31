import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "./crypto";

// Resolve an OAuth app's client_id + client_secret for a given user
// and provider. Order:
//   1. user_oauth_credentials row (user's own OAuth app)
//   2. server env var (developer-supplied fallback, useful for the
//      single-user-on-localhost case)
// Returns null if neither is configured.

export type OAuthProvider = "github" | "youtube" | "tiktok" | "instagram";

const ENV_KEYS: Record<
  OAuthProvider,
  { idVar: string; secretVar: string }
> = {
  github: {
    idVar: "GITHUB_OAUTH_CLIENT_ID",
    secretVar: "GITHUB_OAUTH_CLIENT_SECRET",
  },
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
  source: "user" | "env";
};

export async function getOAuthCredentials(
  supabase: SupabaseClient,
  userId: string,
  provider: OAuthProvider,
): Promise<OAuthCredentials | null> {
  // 1. User's own OAuth app.
  const { data } = await supabase
    .from("user_oauth_credentials")
    .select("encrypted_client_id, encrypted_client_secret")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle();
  if (data?.encrypted_client_id && data.encrypted_client_secret) {
    try {
      return {
        client_id: decrypt(data.encrypted_client_id),
        client_secret: decrypt(data.encrypted_client_secret),
        source: "user",
      };
    } catch (err) {
      console.error(
        `Failed to decrypt user OAuth creds for ${provider}/${userId}:`,
        err,
      );
      // fall through to env
    }
  }

  // 2. Server env fallback.
  const env = ENV_KEYS[provider];
  const id = process.env[env.idVar];
  const secret = process.env[env.secretVar];
  if (id && secret) {
    return { client_id: id, client_secret: secret, source: "env" };
  }

  return null;
}
