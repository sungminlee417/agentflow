import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encrypt, last4 } from "@agentflow/core";

const VALID_PROVIDERS = ["github", "youtube", "tiktok", "instagram"] as const;
type Provider = (typeof VALID_PROVIDERS)[number];

function isProvider(s: string): s is Provider {
  return (VALID_PROVIDERS as readonly string[]).includes(s);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data, error } = await supabase
    .from("user_oauth_credentials")
    .select("provider, client_id_last4, updated_at");
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ credentials: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { provider?: string; client_id?: string; client_secret?: string }
    | null;
  if (
    !body?.provider ||
    !isProvider(body.provider) ||
    !body.client_id ||
    !body.client_secret
  ) {
    return new NextResponse(
      "provider, client_id, and client_secret are required",
      { status: 400 },
    );
  }
  const id = body.client_id.trim();
  const secret = body.client_secret.trim();
  if (id.length < 4 || secret.length < 4) {
    return new NextResponse("client_id / client_secret look too short", {
      status: 400,
    });
  }

  let encId: string;
  let encSecret: string;
  try {
    encId = encrypt(id);
    encSecret = encrypt(secret);
  } catch (err) {
    return new NextResponse(
      err instanceof Error ? err.message : "Encryption failed",
      { status: 500 },
    );
  }

  const { error } = await supabase.from("user_oauth_credentials").upsert(
    {
      user_id: user.id,
      provider: body.provider,
      encrypted_client_id: encId,
      encrypted_client_secret: encSecret,
      client_id_last4: last4(id),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,provider" },
  );

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const provider = new URL(request.url).searchParams.get("provider");
  if (!provider || !isProvider(provider)) {
    return new NextResponse("unknown provider", { status: 400 });
  }

  const { error } = await supabase
    .from("user_oauth_credentials")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", provider);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
