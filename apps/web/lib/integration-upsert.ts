import type { SupabaseClient } from "@supabase/supabase-js";

// Shared OAuth-callback upsert. Now multi-account aware:
//   • If a row exists for (user, provider, real provider_account_id),
//     update its tokens — the user is reconnecting the same account.
//   • Else if a row exists for (user, provider, 'legacy') — a row
//     migrated from the pre-multi-account schema — upgrade its
//     provider_account_id to the real one and update everything else.
//     This preserves any video_ideas / video_ideas_settings pointing
//     at that integration_id.
//   • Else insert a new row.

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

export async function upsertIntegrationByAccount(
  supabase: SupabaseClient,
  args: UpsertArgs,
): Promise<{ error: string | null; integrationId: string | null }> {
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
    return { error: error?.message ?? null, integrationId: existing.id };
  }

  // 2. Legacy row from pre-multi-account schema → upgrade in place.
  const { data: legacy } = await supabase
    .from("integrations")
    .select("id")
    .eq("user_id", args.userId)
    .eq("provider", args.provider)
    .eq("provider_account_id", "legacy")
    .maybeSingle();
  if (legacy?.id) {
    const { error } = await supabase
      .from("integrations")
      .update(baseFields)
      .eq("id", legacy.id);
    return { error: error?.message ?? null, integrationId: legacy.id };
  }

  // 3. Fresh row.
  const { data: inserted, error } = await supabase
    .from("integrations")
    .insert(baseFields)
    .select("id")
    .single();
  return {
    error: error?.message ?? null,
    integrationId: inserted?.id ?? null,
  };
}
