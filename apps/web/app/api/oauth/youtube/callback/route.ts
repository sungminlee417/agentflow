import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  encrypt,
  getOAuthCredentials,
  managerForProvider,
} from "@agentflow/core";

const STATE_COOKIE = "yt_oauth_state";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

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
      new URL(`${managerLanding}?error=oauth_state_mismatch`, request.url),
    );
  }

  const creds = await getOAuthCredentials(supabase, user.id, "youtube");
  if (!creds) {
    return NextResponse.redirect(
      new URL(`${managerLanding}?error=oauth_app_not_configured`, request.url),
    );
  }

  const redirectUri = new URL(
    "/api/oauth/youtube/callback",
    request.url,
  ).toString();

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

  const scopes = (tokenData.scope ?? "").split(" ").filter(Boolean);
  const expiresAt = tokenData.expires_in
    ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
    : null;

  const { error } = await supabase.from("integrations").upsert(
    {
      user_id: user.id,
      domain: "youtube",
      provider: "youtube",
      encrypted_access_token: encrypt(tokenData.access_token),
      encrypted_refresh_token: tokenData.refresh_token
        ? encrypt(tokenData.refresh_token)
        : null,
      scopes,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,domain,provider" },
  );

  if (error) {
    return NextResponse.redirect(
      new URL(
        `${managerLanding}?error=${encodeURIComponent("store_failed:" + error.message)}`,
        request.url,
      ),
    );
  }

  const response = NextResponse.redirect(
    new URL(`${managerLanding}?connected=youtube`, request.url),
  );
  response.cookies.delete(STATE_COOKIE);
  return response;
}
