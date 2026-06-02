import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "../crypto";
import { getFreshAccessToken } from "../oauth-refresh";
import type { OAuthProvider } from "../oauth-credentials";
import { buildGitHubTools } from "./github";
import { buildYouTubeTools } from "./youtube";
import { buildTikTokTools } from "./tiktok";
import { buildInstagramTools } from "./instagram";
import { buildApifyTikTokTools, loadApifyKey } from "./apify-tiktok";
import { buildUploadsTools } from "./uploads";
import { buildTranscriptionTools, loadOpenAIKey } from "./transcription";

// Compose the agent's tool set from the user's connected integrations
// + service keys + analytics uploads. Anything not configured simply
// isn't exposed to the model.
//
// Per OAuth integration, we lazily refresh the access token if it's
// close to expiring — so an agent run that happens 25 hours after the
// user connected TikTok still has a working token without manual
// reconnect.

const REFRESHABLE_PROVIDERS: ReadonlySet<OAuthProvider> = new Set([
  "tiktok",
  "youtube",
  "instagram",
]);

export async function buildToolsForUser(
  supabase: SupabaseClient,
  userId: string,
) {
  const tools: Record<string, unknown> = {};
  const connected: string[] = [];

  const { data: integrations } = await supabase
    .from("integrations")
    .select(
      "provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("user_id", userId);

  for (const i of integrations ?? []) {
    if (!i.encrypted_access_token) continue;
    try {
      const provider = i.provider as string;
      // For providers with short-lived tokens, refresh transparently
      // before building tools. For GitHub (long-lived), just decrypt.
      const token = REFRESHABLE_PROVIDERS.has(provider as OAuthProvider)
        ? await getFreshAccessToken(supabase, userId, provider as OAuthProvider, {
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

  // Apify-backed niche/competitor tools — opt-in via user's Apify key.
  const apifyToken = await loadApifyKey(supabase, userId, decrypt);
  if (apifyToken) {
    Object.assign(tools, buildApifyTikTokTools(apifyToken));
    connected.push("apify");
  }

  // Transcription tool — needs Apify (for video URL) + OpenAI key (for
  // Whisper). Surfaced as one tool the agent can call on any TikTok URL.
  const openaiKey = await loadOpenAIKey(supabase, userId);
  if (apifyToken && openaiKey) {
    Object.assign(tools, buildTranscriptionTools(apifyToken, openaiKey));
    connected.push("transcription");
  }

  // Uploaded analytics exports — always available; reads from DB.
  Object.assign(tools, buildUploadsTools(supabase, userId));

  return { tools, connected };
}
