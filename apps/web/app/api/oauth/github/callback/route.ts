import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/crypto";

// Finish the GitHub OAuth flow:
//   1. Verify state matches the cookie we set in /start
//   2. Exchange the code for an access token at GitHub's token endpoint
//   3. Encrypt and upsert into the integrations table
//   4. Redirect back to /settings

const STATE_COOKIE = "gh_oauth_state";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(
      new URL("/settings?error=oauth_state_mismatch", request.url),
    );
  }

  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new NextResponse(
      "GitHub OAuth credentials are not set on the server.",
      { status: 500 },
    );
  }

  // Exchange code for token.
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: new URL(
        "/api/oauth/github/callback",
        request.url,
      ).toString(),
    }),
  });

  const tokenData = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!tokenData?.access_token) {
    const errorMsg = tokenData?.error_description ?? tokenData?.error ?? "unknown";
    return NextResponse.redirect(
      new URL(
        `/settings?error=${encodeURIComponent(`github_exchange_failed:${errorMsg}`)}`,
        request.url,
      ),
    );
  }

  const scopes = (tokenData.scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { error } = await supabase.from("integrations").upsert(
    {
      user_id: user.id,
      domain: "github",
      provider: "github",
      encrypted_access_token: encrypt(tokenData.access_token),
      encrypted_refresh_token: null,
      scopes,
      expires_at: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,domain,provider" },
  );

  if (error) {
    return NextResponse.redirect(
      new URL(
        `/settings?error=${encodeURIComponent("store_failed:" + error.message)}`,
        request.url,
      ),
    );
  }

  const response = NextResponse.redirect(
    new URL("/settings?connected=github", request.url),
  );
  response.cookies.delete(STATE_COOKIE);
  return response;
}
