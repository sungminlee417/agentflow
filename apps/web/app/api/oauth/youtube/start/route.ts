import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOAuthCredentials, managerForProvider } from "@agentflow/core";
import { publicUrl } from "@/lib/public-url";

const STATE_COOKIE = "yt_oauth_state";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(publicUrl(request, "/login"));

  const creds = await getOAuthCredentials(supabase, user.id, "youtube");
  if (!creds) {
    const landing =
      managerForProvider("youtube")?.slug
        ? `/managers/${managerForProvider("youtube")!.slug}`
        : "/settings";
    return NextResponse.redirect(
      publicUrl(request, `${landing}?error=oauth_app_not_configured`),
    );
  }

  const state = randomBytes(24).toString("hex");
  const redirectUri = publicUrl(request, "/api/oauth/youtube/callback");

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", creds.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPES.join(" "));
  authorizeUrl.searchParams.set("access_type", "offline");
  // `select_account` forces Google to show the account picker even
  // when the user is already signed in — required for multi-account
  // YouTube support. Without it, the second "Connect YouTube" click
  // silently picks the already-signed-in Google account, returns the
  // same channel id, and the callback's upsert overwrites the
  // existing integration row in place (looking like a swap to the
  // user). `consent` is bundled so the offline refresh-token flow
  // still triggers the consent screen each time.
  authorizeUrl.searchParams.set("prompt", "select_account consent");
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return response;
}
