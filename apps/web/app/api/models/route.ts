import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, isProvider, listModels } from "@agentflow/core";

// Live model catalog for the authenticated user's stored key. Hits the
// provider's /models endpoint with the user's own API key so the list
// reflects what they actually have access to.
//
// No caching for now — fetched once per page-load when ApiKeyForm
// mounts. If this becomes hot we can add an in-memory ttl cache here.

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const provider = new URL(request.url).searchParams.get("provider");
  if (!provider || !isProvider(provider)) {
    return new NextResponse("unknown provider", { status: 400 });
  }

  const { data: row } = await supabase
    .from("user_api_keys")
    .select("encrypted_key")
    .eq("user_id", user.id)
    .eq("provider", provider)
    .maybeSingle();
  if (!row?.encrypted_key) {
    return new NextResponse("no key configured for provider", { status: 404 });
  }

  let apiKey: string;
  try {
    apiKey = decrypt(row.encrypted_key);
  } catch (err) {
    return new NextResponse(
      `Could not decrypt key: ${err instanceof Error ? err.message : "unknown"}`,
      { status: 500 },
    );
  }

  try {
    const models = await listModels(provider, apiKey);
    return NextResponse.json({ models });
  } catch (err) {
    return new NextResponse(
      err instanceof Error ? err.message : "list models failed",
      { status: 502 },
    );
  }
}
