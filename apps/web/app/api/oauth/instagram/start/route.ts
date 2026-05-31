import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOAuthCredentials, managerForProvider } from "@agentflow/core";

const STATE_COOKIE = "ig_oauth_state";

const SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
  "instagram_business_manage_comments",
];

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));

  const creds = await getOAuthCredentials(supabase, user.id, "instagram");
  if (!creds) {
    const landing =
      managerForProvider("instagram")?.slug
        ? `/managers/${managerForProvider("instagram")!.slug}`
        : "/settings";
    return NextResponse.redirect(
      new URL(`${landing}?error=oauth_app_not_configured`, request.url),
    );
  }

  const state = randomBytes(24).toString("hex");
  const redirectUri = new URL(
    "/api/oauth/instagram/callback",
    request.url,
  ).toString();

  const authorizeUrl = new URL("https://www.instagram.com/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", creds.client_id);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPES.join(","));
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
