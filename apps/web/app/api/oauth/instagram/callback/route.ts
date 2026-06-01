import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  encrypt,
  getOAuthCredentials,
  managerForProvider,
} from "@agentflow/core";
import { publicUrl } from "@/lib/public-url";

const STATE_COOKIE = "ig_oauth_state";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(publicUrl(request, "/login"));

  const managerLanding =
    managerForProvider("instagram")?.slug
      ? `/managers/${managerForProvider("instagram")!.slug}`
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

  const creds = await getOAuthCredentials(supabase, user.id, "instagram");
  if (!creds) {
    return NextResponse.redirect(
      publicUrl(request, `${managerLanding}?error=oauth_app_not_configured`),
    );
  }

  const redirectUri = publicUrl(request, "/api/oauth/instagram/callback");

  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  });
  const shortData = (await shortRes.json().catch(() => null)) as {
    access_token?: string;
    user_id?: string | number;
    permissions?: string[];
    error_message?: string;
  } | null;
  if (!shortData?.access_token) {
    const errMsg = shortData?.error_message ?? "exchange_failed";
    return NextResponse.redirect(
      new URL(
        `${managerLanding}?error=${encodeURIComponent(`instagram_exchange_failed:${errMsg}`)}`,
        request.url,
      ),
    );
  }

  const longRes = await fetch(
    `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(
      creds.client_secret,
    )}&access_token=${encodeURIComponent(shortData.access_token)}`,
  );
  const longData = (await longRes.json().catch(() => null)) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  } | null;

  const finalToken = longData?.access_token ?? shortData.access_token;
  const expiresAt = longData?.expires_in
    ? new Date(Date.now() + longData.expires_in * 1000).toISOString()
    : null;

  const { error } = await supabase.from("integrations").upsert(
    {
      user_id: user.id,
      domain: "instagram",
      provider: "instagram",
      encrypted_access_token: encrypt(finalToken),
      encrypted_refresh_token: null,
      scopes: shortData.permissions ?? [],
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,domain,provider" },
  );

  if (error) {
    return NextResponse.redirect(
      publicUrl(
        request,
        `${managerLanding}?error=${encodeURIComponent("store_failed:" + error.message)}`,
      ),
    );
  }

  const response = NextResponse.redirect(
    publicUrl(request, `${managerLanding}?connected=instagram`),
  );
  response.cookies.delete(STATE_COOKIE);
  return response;
}
