import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "../crypto";
import { getFreshAccessToken } from "../oauth-refresh";
import type { OAuthProvider } from "../oauth-credentials";
import { buildYouTubeTools } from "./youtube";
import { buildTikTokTools } from "./tiktok";
import { buildInstagramTools } from "./instagram";
import { buildApifyTikTokTools, loadApifyKey } from "./apify-tiktok";
import { buildApifyInstagramTools } from "./apify-instagram";
import { buildUploadsTools } from "./uploads";
import { buildTranscriptionTools, loadOpenAIKey } from "./transcription";
import { buildVideoIdeasTools } from "./video-ideas";
import type { ProviderAccount } from "./account-resolver";

// Compose the agent's tool set from connected integrations + service
// keys + uploads. Multi-account aware: a user may have several
// integrations for the same provider (e.g. two YouTube channels). Each
// refreshable-provider tool family is built ONCE with the full list of
// connected accounts and tools route to the right one via an `account`
// input parameter (see ./account-resolver.ts).
//
// Two entrypoints:
//   buildToolsForUser     — every connected integration the user has.
//                           Used by chat where the agent decides which
//                           account to query (via *_list_my_accounts).
//   buildToolsForIntegrations — builds tools for a specific list of
//                           integration rows. Used by /video-ideas
//                           which is already account-scoped per agent
//                           run; the resulting tool set will have one
//                           ProviderAccount per provider and the agent
//                           can omit the `account` param.
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
  // Multi-account labeling. Populated at OAuth callback time when
  // available; null on older rows.
  handle?: string | null;
  display_name?: string | null;
  account_label?: string | null;
};

const INTEGRATION_SELECT =
  "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at, handle, display_name, account_label, created_at";

export async function buildToolsForUser(
  supabase: SupabaseClient,
  userId: string,
) {
  const { data: integrations } = await supabase
    .from("integrations")
    .select(INTEGRATION_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: true });

  // Pass ALL rows through — refreshable-provider builders now route
  // per account via the `account` parameter, so we no longer want to
  // dedupe down to one integration per provider.
  return buildToolsForIntegrations(
    supabase,
    userId,
    (integrations ?? []) as IntegrationRow[],
  );
}

function labelFor(row: IntegrationRow): string {
  return (
    row.account_label?.trim() ||
    row.display_name?.trim() ||
    row.handle?.trim() ||
    `${row.provider} (${row.id.slice(0, 8)})`
  );
}

// Build a ProviderAccount with a memoized lazy token fetcher. The
// refresh happens at most once per chat-request lifetime, regardless
// of how many tool calls hit the same account.
function makeProviderAccount(
  supabase: SupabaseClient,
  userId: string,
  row: IntegrationRow,
): ProviderAccount {
  let cached: Promise<string> | null = null;
  return {
    id: row.id,
    label: labelFor(row),
    handle: row.handle ?? null,
    getToken: () => {
      if (!cached) {
        cached = getFreshAccessToken(
          supabase,
          userId,
          row.provider as OAuthProvider,
          {
            id: row.id,
            encrypted_access_token: row.encrypted_access_token,
            encrypted_refresh_token: row.encrypted_refresh_token,
            expires_at: row.expires_at,
          },
        );
      }
      return cached;
    },
  };
}

export async function buildToolsForIntegrations(
  supabase: SupabaseClient,
  userId: string,
  integrations: IntegrationRow[],
) {
  const tools: Record<string, unknown> = {};
  const connected: string[] = [];

  // Group by provider so each per-provider builder sees ALL accounts
  // for its provider at once (every supported provider is refreshable
  // now that GitHub has been removed).
  const byProvider = new Map<string, IntegrationRow[]>();
  for (const i of integrations) {
    if (!i.encrypted_access_token) continue;
    if (!REFRESHABLE_PROVIDERS.has(i.provider as OAuthProvider)) continue;
    const arr = byProvider.get(i.provider) ?? [];
    arr.push(i);
    byProvider.set(i.provider, arr);
  }

  for (const [provider, rows] of byProvider) {
    const accounts = rows.map((r) => makeProviderAccount(supabase, userId, r));
    try {
      switch (provider) {
        case "youtube":
          Object.assign(tools, buildYouTubeTools(accounts));
          connected.push("youtube");
          break;
        case "tiktok":
          Object.assign(tools, buildTikTokTools(accounts));
          connected.push("tiktok");
          break;
        case "instagram":
          Object.assign(tools, buildInstagramTools(accounts));
          connected.push("instagram");
          break;
      }
    } catch (err) {
      console.error(
        `Failed to prepare ${provider} tools for user ${userId}:`,
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
