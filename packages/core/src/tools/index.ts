import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "../crypto";
import { getFreshAccessToken } from "../oauth-refresh";
import type { OAuthProvider } from "../oauth-credentials";
import { buildGitHubTools } from "./github";
import { buildYouTubeTools } from "./youtube";
import { buildTikTokTools } from "./tiktok";
import { buildInstagramTools } from "./instagram";
import { buildApifyTikTokTools, loadApifyKey } from "./apify-tiktok";
import { buildApifyInstagramTools } from "./apify-instagram";
import { buildUploadsTools } from "./uploads";
import { buildTranscriptionTools, loadOpenAIKey } from "./transcription";
import { buildVideoIdeasTools } from "./video-ideas";

// Compose the agent's tool set from connected integrations + service
// keys + uploads. Multi-account aware: a user may have several
// integrations for the same provider (e.g. two TikTok accounts).
//
// Two entrypoints:
//   buildToolsForUser     — picks one integration per provider (the
//                           oldest by created_at). Used by chat,
//                           briefs, and scripts where there's no
//                           explicit account selection yet.
//   buildToolsForIntegrations — builds tools for a specific list of
//                           integration rows. Used by /video-ideas
//                           which is account-aware.
//
// User-level extras (Apify, Whisper, uploads) are always added on
// top — they're not OAuth-scoped.

const REFRESHABLE_PROVIDERS: ReadonlySet<OAuthProvider> = new Set([
  "tiktok",
  "youtube",
  "instagram",
]);

export type IntegrationRow = {
  id: string;
  provider: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string | null;
  expires_at: string | null;
};

const INTEGRATION_SELECT =
  "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at, created_at";

export async function buildToolsForUser(
  supabase: SupabaseClient,
  userId: string,
) {
  const { data: integrations } = await supabase
    .from("integrations")
    .select(INTEGRATION_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  // Pick the oldest integration per provider — deterministic default
  // when multiple accounts exist for the same provider.
  const byProvider = new Map<string, IntegrationRow>();
  for (const row of (integrations ?? []) as IntegrationRow[]) {
    if (!byProvider.has(row.provider)) byProvider.set(row.provider, row);
  }

  return buildToolsForIntegrations(supabase, userId, [...byProvider.values()]);
}

export async function buildToolsForIntegrations(
  supabase: SupabaseClient,
  userId: string,
  integrations: IntegrationRow[],
) {
  const tools: Record<string, unknown> = {};
  const connected: string[] = [];

  for (const i of integrations) {
    if (!i.encrypted_access_token) continue;
    try {
      const provider = i.provider;
      const token = REFRESHABLE_PROVIDERS.has(provider as OAuthProvider)
        ? await getFreshAccessToken(supabase, userId, provider as OAuthProvider, {
            // The id is what scopes the post-refresh UPDATE to THIS
            // row. Without it the refresh writes the new token into
            // every integration the user has for the provider, which
            // cross-contaminates accounts when multiple are connected.
            id: i.id,
            encrypted_access_token: i.encrypted_access_token,
            encrypted_refresh_token: i.encrypted_refresh_token,
            expires_at: i.expires_at,
          })
        : decrypt(i.encrypted_access_token);

      switch (provider) {
        case "github":
          Object.assign(tools, buildGitHubTools(token));
          connected.push("github");
          break;
        case "youtube":
          Object.assign(tools, buildYouTubeTools(token));
          connected.push("youtube");
          break;
        case "tiktok":
          Object.assign(tools, buildTikTokTools(token));
          connected.push("tiktok");
          break;
        case "instagram":
          Object.assign(tools, buildInstagramTools(token));
          connected.push("instagram");
          break;
      }
    } catch (err) {
      console.error(
        `Failed to prepare ${i.provider} tools for user ${userId}:`,
        err,
      );
    }
  }

  // User-level extras (not OAuth-scoped).
  const apifyToken = await loadApifyKey(supabase, userId, decrypt);
  if (apifyToken) {
    Object.assign(tools, buildApifyTikTokTools(apifyToken));
    Object.assign(tools, buildApifyInstagramTools(apifyToken));
    connected.push("apify");
  }

  const openaiKey = await loadOpenAIKey(supabase, userId);
  if (apifyToken && openaiKey) {
    Object.assign(tools, buildTranscriptionTools(apifyToken, openaiKey));
    connected.push("transcription");
  }

  Object.assign(tools, buildUploadsTools(supabase, userId));
  Object.assign(tools, buildVideoIdeasTools(supabase, userId));

  return { tools, connected };
}

// Fetch a single integration row by id, scoped to the user.
export async function loadIntegration(
  supabase: SupabaseClient,
  userId: string,
  integrationId: string,
): Promise<IntegrationRow | null> {
  const { data } = await supabase
    .from("integrations")
    .select(INTEGRATION_SELECT)
    .eq("user_id", userId)
    .eq("id", integrationId)
    .maybeSingle();
  return (data ?? null) as IntegrationRow | null;
}
