import { NextResponse, type NextRequest } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getOAuthCredentials } from "@agentflow/core";
import { publicUrl } from "@/lib/public-url";

const STATE_COOKIE = "tt_oauth_state";
const VERIFIER_COOKIE = "tt_oauth_verifier";
const SCOPES = ["user.info.basic", "user.info.profile", "user.info.stats", "video.list"];

function base64Url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(publicUrl(request, "/login"));

  const creds = await getOAuthCredentials(supabase, user.id, "tiktok");
  if (!creds) {
    return NextResponse.redirect(
      publicUrl(request, "/integrations?error=oauth_app_not_configured"),
    );
  }

  const state = randomBytes(24).toString("hex");
  const codeVerifier = base64Url(randomBytes(32));
  const codeChallenge = base64Url(
    createHash("sha256").update(codeVerifier).digest(),
  );

  const redirectUri = publicUrl(request, "/api/oauth/tiktok/callback");
  // If we're behind an HTTPS tunnel (ngrok / Vercel), cookies must be
  // `secure: true` for cross-site sameSite=lax behavior to work
  // reliably during the OAuth redirect. We detect via x-forwarded-proto.
  const isHttps =
    request.headers.get("x-forwarded-proto") === "https" ||
    process.env.NODE_ENV === "production";

  const authorizeUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
  authorizeUrl.searchParams.set("client_key", creds.client_id);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", SCOPES.join(","));
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  // Force the consent screen every time. Without this, TikTok silently
  // auto-approves whichever account previously authorized this app,
  // which makes adding a second account from the same browser nearly
  // impossible. With disable_auto_auth=1, the user sees the consent
  // screen, can verify which TikTok account it's running against, and
  // can back out + switch accounts if it's wrong.
  authorizeUrl.searchParams.set("disable_auto_auth", "1");

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  response.cookies.set(VERIFIER_COOKIE, codeVerifier, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return response;
}
