import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Begin the GitHub OAuth flow:
//   1. Generate a random state value (CSRF protection)
//   2. Store it in an httpOnly cookie
//   3. Redirect to GitHub's authorize endpoint

const STATE_COOKIE = "gh_oauth_state";
const SCOPES = ["repo", "project"]; // repo: code/issues/PRs · project: ProjectsV2 board updates

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    return new NextResponse(
      "GITHUB_OAUTH_CLIENT_ID is not set on the server.",
      { status: 500 },
    );
  }

  const state = randomBytes(24).toString("hex");
  const redirectUri = new URL(
    "/api/oauth/github/callback",
    request.url,
  ).toString();

  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", SCOPES.join(" "));
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10, // 10 minutes
  });
  return response;
}
