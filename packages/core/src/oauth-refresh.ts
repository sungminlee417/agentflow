import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt, encrypt } from "./crypto";
import { getOAuthCredentials, type OAuthProvider } from "./oauth-credentials";

// Transparent OAuth access-token refresh.
//
// Most providers issue short-lived access tokens (TikTok: 24h,
// Google/YouTube: ~1h, Instagram long-lived: ~60d). We store a
// refresh_token at connect time and use it to mint a new
// access_token before it expires. Called lazily from buildToolsForUser.
//
// If refresh fails for any reason (revoked token, network error,
// expired refresh_token), we return the stored (possibly stale)
// access_token and let the downstream API call surface the real
// error to the agent — better than silently swallowing it.

type IntegrationRow = {
  id?: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  expires_at: string | null;
};

// Refresh if the token expires within this many seconds.
const REFRESH_BUFFER_SEC = 5 * 60;

export async function getFreshAccessToken(
  supabase: SupabaseClient,
  userId: string,
  provider: OAuthProvider,
  row: IntegrationRow,
): Promise<string> {
  const current = decrypt(row.encrypted_access_token);
  if (!shouldRefresh(row)) return current;
  if (!row.encrypted_refresh_token) return current; // no refresh available

  let refreshToken: string;
  try {
    refreshToken = decrypt(row.encrypted_refresh_token);
  } catch {
    return current;
  }

  const creds = await getOAuthCredentials(supabase, userId, provider);
  if (!creds) return current;

  try {
    const refreshed = await callRefreshEndpoint(provider, creds, refreshToken);
    if (!refreshed) return current;

    const expiresAt = refreshed.expires_in
      ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
      : null;

    // Scope the update by integration id. Without an id this would
    // write to every (user, provider) row — cross-contaminating
    // tokens between accounts whenever the user has more than one.
    // We refuse the update rather than risk corruption: the refreshed
    // token is still returned to the caller, just not persisted, and
    // the next refresh cycle will retry.
    if (!row.id) {
      console.error(
        `[oauth-refresh] ${provider} for ${userId}: row.id missing — not persisting refreshed token to avoid cross-account contamination`,
      );
      return refreshed.access_token;
    }
    await supabase
      .from("integrations")
      .update({
        encrypted_access_token: encrypt(refreshed.access_token),
        encrypted_refresh_token: refreshed.refresh_token
          ? encrypt(refreshed.refresh_token)
          : row.encrypted_refresh_token,
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("id", row.id);

    return refreshed.access_token;
  } catch (err) {
    console.error(
      `[oauth-refresh] ${provider} for ${userId} failed:`,
      err instanceof Error ? err.message : err,
    );
    return current;
  }
}

function shouldRefresh(row: IntegrationRow): boolean {
  if (!row.expires_at) return false;
  const expiresAt = new Date(row.expires_at).getTime();
  const dueAt = Date.now() + REFRESH_BUFFER_SEC * 1000;
  return expiresAt <= dueAt;
}

type RefreshedTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

async function callRefreshEndpoint(
  provider: OAuthProvider,
  creds: { client_id: string; client_secret: string },
  refreshToken: string,
): Promise<RefreshedTokens | null> {
  switch (provider) {
    case "tiktok": {
      const res = await fetch(
        "https://open.tiktokapis.com/v2/oauth/token/",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_key: creds.client_id,
            client_secret: creds.client_secret,
            grant_type: "refresh_token",
            refresh_token: refreshToken,
          }),
        },
      );
      if (!res.ok) {
        console.error(`TikTok refresh ${res.status}: ${await res.text()}`);
        return null;
      }
      const json = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
      };
      if (!json.access_token) return null;
      return {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_in: json.expires_in,
      };
    }

    case "youtube": {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.client_id,
          client_secret: creds.client_secret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      if (!res.ok) {
        console.error(`Google refresh ${res.status}: ${await res.text()}`);
        return null;
      }
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!json.access_token) return null;
      return {
        access_token: json.access_token,
        // Google doesn't return a new refresh_token on refresh — the
        // original keeps working.
        expires_in: json.expires_in,
      };
    }

    case "instagram": {
      // Instagram long-lived tokens (60d) self-refresh via a different
      // endpoint that takes the CURRENT access token (not a refresh
      // token). Use refreshToken as the input here — when we stored
      // the long-lived token we also stored it as refresh_token
      // conceptually. If callers haven't, this returns null.
      const url = new URL("https://graph.instagram.com/refresh_access_token");
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", refreshToken);
      const res = await fetch(url.toString());
      if (!res.ok) {
        console.error(`Instagram refresh ${res.status}: ${await res.text()}`);
        return null;
      }
      const json = (await res.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!json.access_token) return null;
      return {
        access_token: json.access_token,
        // The "refreshed" token also serves as the next refresh input.
        refresh_token: json.access_token,
        expires_in: json.expires_in,
      };
    }

    case "github":
      // GitHub OAuth tokens don't expire by default (only GitHub Apps
      // do, and we'd implement that separately). Nothing to refresh.
      return null;
  }
}
