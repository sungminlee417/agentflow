import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encrypt, last4 } from "@/lib/crypto";
import { isProvider } from "@/lib/ai-providers";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { provider?: string; key?: string }
    | null;
  if (!body?.provider || !body?.key) {
    return new NextResponse("provider and key are required", { status: 400 });
  }
  if (!isProvider(body.provider)) {
    return new NextResponse("unknown provider", { status: 400 });
  }
  const trimmed = body.key.trim();
  if (trimmed.length < 8) {
    return new NextResponse("key looks too short", { status: 400 });
  }

  let encrypted: string;
  try {
    encrypted = encrypt(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Encryption failed";
    return new NextResponse(message, { status: 500 });
  }

  const { error } = await supabase.from("user_api_keys").upsert(
    {
      user_id: user.id,
      provider: body.provider,
      encrypted_key: encrypted,
      key_last4: last4(trimmed),
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
    .from("user_api_keys")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", provider);

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
