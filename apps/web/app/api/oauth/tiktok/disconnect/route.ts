import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, getOAuthCredentials } from "@agentflow/core";

// Disconnect a specific TikTok account. Two-step:
//   1. Tell TikTok to revoke the access token (so the app no longer
//      has standing authorization on the user's TikTok side — without
//      this, reconnecting from the same browser silently auto-approves
//      the same account again).
//   2. Delete the integration row(s) locally.
//
// Caller passes ?integration_id=<uuid> to scope to one account. Without
// it we disconnect all rows for tiktok (fallback for older callers).

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const integrationId = new URL(request.url).searchParams.get("integration_id");

  // Best-effort revoke against TikTok before deleting the row(s).
  try {
    const creds = await getOAuthCredentials(supabase, user.id, "tiktok");
    if (creds) {
      let query = supabase
        .from("integrations")
        .select("encrypted_access_token")
        .eq("user_id", user.id)
        .eq("provider", "tiktok");
      if (integrationId) query = query.eq("id", integrationId);
      const { data: rows } = await query;
      for (const row of rows ?? []) {
        if (!row.encrypted_access_token) continue;
        let token: string;
        try {
          token = decrypt(row.encrypted_access_token);
        } catch {
          continue;
        }
        try {
          const res = await fetch(
            "https://open.tiktokapis.com/v2/oauth/revoke/",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_key: creds.client_id,
                client_secret: creds.client_secret,
                token,
              }),
            },
          );
          if (!res.ok) {
            console.warn(
              `[tiktok/disconnect] revoke failed ${res.status}: ${(await res.text()).slice(0, 200)}`,
            );
          }
        } catch (err) {
          console.warn("[tiktok/disconnect] revoke errored:", err);
        }
      }
    }
  } catch (err) {
    console.warn("[tiktok/disconnect] pre-delete revoke step failed:", err);
  }

  let deleteQuery = supabase
    .from("integrations")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", "tiktok");
  if (integrationId) deleteQuery = deleteQuery.eq("id", integrationId);

  const { error } = await deleteQuery;
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
