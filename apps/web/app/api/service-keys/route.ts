import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { encrypt, last4 } from "@agentflow/core";

const VALID_SERVICES = ["apify"] as const;
type Service = (typeof VALID_SERVICES)[number];

function isService(s: string): s is Service {
  return (VALID_SERVICES as readonly string[]).includes(s);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data, error } = await supabase
    .from("user_service_keys")
    .select("service, key_last4, updated_at");
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ keys: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { service?: string; key?: string }
    | null;
  if (!body?.service || !isService(body.service) || !body.key) {
    return new NextResponse("service and key are required", { status: 400 });
  }
  const trimmed = body.key.trim();
  if (trimmed.length < 8) {
    return new NextResponse("key looks too short", { status: 400 });
  }

  let encrypted: string;
  try {
    encrypted = encrypt(trimmed);
  } catch (err) {
    return new NextResponse(
      err instanceof Error ? err.message : "Encryption failed",
      { status: 500 },
    );
  }

  const { error } = await supabase.from("user_service_keys").upsert(
    {
      user_id: user.id,
      service: body.service,
      encrypted_key: encrypted,
      key_last4: last4(trimmed),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,service" },
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

  const service = new URL(request.url).searchParams.get("service");
  if (!service || !isService(service)) {
    return new NextResponse("unknown service", { status: 400 });
  }

  const { error } = await supabase
    .from("user_service_keys")
    .delete()
    .eq("user_id", user.id)
    .eq("service", service);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
