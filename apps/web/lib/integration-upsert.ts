import type { SupabaseClient } from "@supabase/supabase-js";

// Shared OAuth-callback upsert. Multi-account aware:
//   • If a row exists for (user, provider, real provider_account_id),
//     update its tokens — the user is reconnecting the same account.
//   • Else insert a new row.
//
// Legacy rows (provider_account_id='legacy' from the multi-account
// migration) are NOT auto-upgraded — we'd have to guess which account
// the legacy row belonged to, and a wrong guess silently hijacks one
// account's row with another account's identity. Users with legacy
// rows should disconnect them explicitly from /integrations.

export type UpsertArgs = {
  userId: string;
  domain: string;
  provider: string;
  providerAccountId: string;
  handle: string | null;
  displayName: string | null;
  encryptedAccessToken: string;
  encryptedRefreshToken: string | null;
  scopes: string[];
  expiresAt: string | null;
};

export type UpsertResult = {
  error: string | null;
  integrationId: string | null;
  action: "created" | "updated";
  handle: string | null;
};

export async function upsertIntegrationByAccount(
  supabase: SupabaseClient,
  args: UpsertArgs,
): Promise<UpsertResult> {
  const now = new Date().toISOString();
  const baseFields = {
    user_id: args.userId,
    domain: args.domain,
    provider: args.provider,
    provider_account_id: args.providerAccountId,
    handle: args.handle,
    display_name: args.displayName,
    encrypted_access_token: args.encryptedAccessToken,
    encrypted_refresh_token: args.encryptedRefreshToken,
    scopes: args.scopes,
    expires_at: args.expiresAt,
    updated_at: now,
  };

  // 1. Existing row for this exact account → update.
  const { data: existing } = await supabase
    .from("integrations")
    .select("id")
    .eq("user_id", args.userId)
    .eq("provider", args.provider)
    .eq("provider_account_id", args.providerAccountId)
    .maybeSingle();
  if (existing?.id) {
    const { error } = await supabase
      .from("integrations")
      .update(baseFields)
      .eq("id", existing.id);
    return {
      error: error?.message ?? null,
      integrationId: existing.id,
      action: "updated",
      handle: args.handle,
    };
  }

  // 2. Fresh row.
  const { data: inserted, error } = await supabase
    .from("integrations")
    .insert(baseFields)
    .select("id")
    .single();
  if (error) {
    console.error(
      `[integration-upsert] insert failed for ${args.provider}/${args.providerAccountId}: ${error.message}`,
    );
  }
  return {
    error: error?.message ?? null,
    integrationId: inserted?.id ?? null,
    action: "created",
    handle: args.handle,
  };
}
