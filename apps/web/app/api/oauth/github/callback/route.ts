import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encrypt, getOAuthCredentials } from "@agentflow/core";
import { publicUrl } from "@/lib/public-url";
import { upsertIntegrationByAccount } from "@/lib/integration-upsert";

const STATE_COOKIE = "gh_oauth_state";

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(publicUrl(request, "/login"));

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = request.cookies.get(STATE_COOKIE)?.value;

  if (!code || !state || state !== cookieState) {
    return NextResponse.redirect(
      publicUrl(request, `/integrations?error=oauth_state_mismatch`),
    );
  }

  const creds = await getOAuthCredentials(supabase, user.id, "github");
  if (!creds) {
    return NextResponse.redirect(
      publicUrl(request, `/integrations?error=oauth_app_not_configured`),
    );
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      code,
      redirect_uri: publicUrl(request, "/api/oauth/github/callback"),
    }),
  });

  const tokenData = (await tokenRes.json().catch(() => null)) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!tokenData?.access_token) {
    const errMsg = tokenData?.error_description ?? tokenData?.error ?? "unknown";
    return NextResponse.redirect(
      new URL(
        `/integrations?error=${encodeURIComponent(`github_exchange_failed:${errMsg}`)}`,
        request.url,
      ),
    );
  }

  // GitHub /user gives the canonical account identity.
  let accountId: string | null = null;
  let handle: string | null = null;
  let displayName: string | null = null;
  try {
    const meRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "agentflow",
      },
    });
    if (meRes.ok) {
      const me = (await meRes.json()) as {
        id?: number;
        login?: string;
        name?: string;
      };
      accountId = me.id != null ? String(me.id) : null;
      handle = me.login ?? null;
      displayName = me.name ?? me.login ?? null;
    }
  } catch (err) {
    console.error("github identity fetch failed:", err);
  }

  if (!accountId) {
    return NextResponse.redirect(
      publicUrl(
        request,
        `/integrations?error=${encodeURIComponent("github_identity_unavailable")}`,
      ),
    );
  }

  const scopes = (tokenData.scope ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const { error, action, handle: resolvedHandle } = await upsertIntegrationByAccount(
    supabase,
    {
      userId: user.id,
      domain: "github",
      provider: "github",
      providerAccountId: accountId,
      handle,
      displayName,
      encryptedAccessToken: encrypt(tokenData.access_token),
      encryptedRefreshToken: null,
      scopes,
      expiresAt: null,
    },
  );

  if (error) {
    return NextResponse.redirect(
      publicUrl(
        request,
        `/integrations?error=${encodeURIComponent("store_failed:" + error)}`,
      ),
    );
  }

  const params = new URLSearchParams({ connected: "github", action });
  if (resolvedHandle) params.set("handle", resolvedHandle);
  const response = NextResponse.redirect(
    publicUrl(request, `/integrations?${params.toString()}`),
  );
  response.cookies.delete(STATE_COOKIE);
  return response;
}
