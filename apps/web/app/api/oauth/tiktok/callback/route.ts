import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  encrypt,
  getOAuthCredentials,
  managerForProvider,
} from "@agentflow/core";
import { publicUrl } from "@/lib/public-url";
import { upsertIntegrationByAccount } from "@/lib/integration-upsert";

const STATE_COOKIE = "tt_oauth_state";
const VERIFIER_COOKIE = "tt_oauth_verifier";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(publicUrl(request, "/login"));

  const managerLanding =
    managerForProvider("tiktok")?.slug
      ? `/managers/${managerForProvider("tiktok")!.slug}`
      : "/settings";

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;
  const codeVerifier = request.cookies.get(VERIFIER_COOKIE)?.value;

  if (!code || !state || state !== cookieState || !codeVerifier) {
    return NextResponse.redirect(
      publicUrl(request, `${managerLanding}?error=oauth_state_mismatch`),
    );
  }

  const creds = await getOAuthCredentials(supabase, user.id, "tiktok");
  if (!creds) {
    return NextResponse.redirect(
      publicUrl(request, `${managerLanding}?error=oauth_app_not_configured`),
    );
  }

  const redirectUri = publicUrl(request, "/api/oauth/tiktok/callback");

  const tokenRes = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_key: creds.client_id,
      client_secret: creds.client_secret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  const tokenData = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    open_id?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!tokenData?.access_token) {
    const errMsg = tokenData?.error_description ?? tokenData?.error ?? "unknown";
    return NextResponse.redirect(
      publicUrl(
        request,
        `${managerLanding}?error=${encodeURIComponent(`tiktok_exchange_failed:${errMsg}`)}`,
      ),
    );
  }

  // Fetch identity. Display API exposes display_name + username.
  let accountId = tokenData.open_id ?? null;
  let handle: string | null = null;
  let displayName: string | null = null;
  try {
    const meRes = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,display_name,username",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );
    const meText = await meRes.text();
    console.log("[tiktok/callback] /v2/user/info status:", meRes.status);
    console.log("[tiktok/callback] /v2/user/info body:", meText.slice(0, 500));
    if (meRes.ok) {
      const meJson = JSON.parse(meText) as {
        data?: {
          user?: {
            open_id?: string;
            display_name?: string;
            username?: string;
          };
        };
      };
      accountId = meJson.data?.user?.open_id ?? accountId;
      handle = meJson.data?.user?.username ?? null;
      displayName = meJson.data?.user?.display_name ?? null;
    }
  } catch (err) {
    console.error("[tiktok/callback] identity fetch failed:", err);
  }

  console.log("[tiktok/callback] resolved account:", {
    accountId,
    handle,
    displayName,
    open_id_from_token: tokenData.open_id,
  });

  if (!accountId) {
    return NextResponse.redirect(
      publicUrl(
        request,
        `${managerLanding}?error=${encodeURIComponent("tiktok_identity_unavailable")}`,
      ),
    );
  }

  const scopes = (tokenData.scope ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  const { error } = await upsertIntegrationByAccount(supabase, {
    userId: user.id,
    domain: "tiktok",
    provider: "tiktok",
    providerAccountId: accountId,
    handle,
    displayName,
    encryptedAccessToken: encrypt(tokenData.access_token),
    encryptedRefreshToken: tokenData.refresh_token
      ? encrypt(tokenData.refresh_token)
      : null,
    scopes,
    expiresAt,
  });

  if (error) {
    return NextResponse.redirect(
      publicUrl(
        request,
        `${managerLanding}?error=${encodeURIComponent("store_failed:" + error)}`,
      ),
    );
  }

  const response = NextResponse.redirect(
    publicUrl(request, `/integrations?connected=tiktok`),
  );
  response.cookies.delete(STATE_COOKIE);
  response.cookies.delete(VERIFIER_COOKIE);
  return response;
}
