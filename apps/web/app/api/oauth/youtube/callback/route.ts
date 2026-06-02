import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  encrypt,
  getOAuthCredentials,
  managerForProvider,
} from "@agentflow/core";
import { publicUrl } from "@/lib/public-url";
import { upsertIntegrationByAccount } from "@/lib/integration-upsert";

const STATE_COOKIE = "yt_oauth_state";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(publicUrl(request, "/login"));

  const managerLanding =
    managerForProvider("youtube")?.slug
      ? `/managers/${managerForProvider("youtube")!.slug}`
      : "/settings";

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(
      publicUrl(request, `${managerLanding}?error=oauth_state_mismatch`),
    );
  }

  const creds = await getOAuthCredentials(supabase, user.id, "youtube");
  if (!creds) {
    return NextResponse.redirect(
      publicUrl(request, `${managerLanding}?error=oauth_app_not_configured`),
    );
  }

  const redirectUri = publicUrl(request, "/api/oauth/youtube/callback");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!tokenData?.access_token) {
    const errMsg = tokenData?.error_description ?? tokenData?.error ?? "unknown";
    return NextResponse.redirect(
      new URL(
        `${managerLanding}?error=${encodeURIComponent(`youtube_exchange_failed:${errMsg}`)}`,
        request.url,
      ),
    );
  }

  // Fetch the YouTube channel identity. mine=true returns the channel
  // owned by the authenticated user.
  let accountId: string | null = null;
  let handle: string | null = null;
  let displayName: string | null = null;
  try {
    const chRes = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
    );
    if (chRes.ok) {
      const json = (await chRes.json()) as {
        items?: Array<{
          id?: string;
          snippet?: { title?: string; customUrl?: string };
        }>;
      };
      const ch = json.items?.[0];
      accountId = ch?.id ?? null;
      handle = ch?.snippet?.customUrl ?? null;
      displayName = ch?.snippet?.title ?? null;
    }
  } catch (err) {
    console.error("youtube identity fetch failed:", err);
  }

  if (!accountId) {
    return NextResponse.redirect(
      publicUrl(
        request,
        `${managerLanding}?error=${encodeURIComponent("youtube_identity_unavailable")}`,
      ),
    );
  }

  const scopes = (tokenData.scope ?? "").split(" ").filter(Boolean);
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  const { error } = await upsertIntegrationByAccount(supabase, {
    userId: user.id,
    domain: "youtube",
    provider: "youtube",
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
    publicUrl(request, `/integrations?connected=youtube`),
  );
  response.cookies.delete(STATE_COOKIE);
  return response;
}
