import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const VALID_PROVIDERS = ["tiktok", "youtube", "instagram"] as const;
const MAX_BYTES = 5 * 1024 * 1024; // 5MB cap
const ALLOWED_TYPES = [
  "text/csv",
  "text/plain",
  "application/csv",
  "application/json",
  "application/vnd.ms-excel", // some browsers send CSV as this
];

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const provider = new URL(request.url).searchParams.get("provider");
  let q = supabase
    .from("creator_analytics_uploads")
    .select("id, provider, label, filename, content_type, size_bytes, created_at")
    .order("created_at", { ascending: false });
  if (provider) q = q.eq("provider", provider);

  const { data, error } = await q;
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ uploads: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const form = await request.formData();
  const file = form.get("file");
  const provider = form.get("provider");
  const label = form.get("label");

  if (typeof provider !== "string" || !VALID_PROVIDERS.includes(provider as never)) {
    return new NextResponse("invalid provider", { status: 400 });
  }
  if (!(file instanceof File)) {
    return new NextResponse("file is required", { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return new NextResponse(
      `file too large (max ${MAX_BYTES / 1024 / 1024}MB)`,
      { status: 413 },
    );
  }
  const contentType = file.type || "text/plain";
  if (
    contentType &&
    !ALLOWED_TYPES.includes(contentType) &&
    !contentType.startsWith("text/")
  ) {
    return new NextResponse(`unsupported content type: ${contentType}`, {
      status: 415,
    });
  }

  const text = await file.text();
  if (text.length === 0) {
    return new NextResponse("file is empty", { status: 400 });
  }

  const finalLabel =
    typeof label === "string" && label.trim().length > 0
      ? label.trim().slice(0, 200)
      : file.name || "Untitled upload";

  const { error } = await supabase.from("creator_analytics_uploads").insert({
    user_id: user.id,
    provider,
    label: finalLabel,
    filename: file.name || null,
    content_type: contentType,
    content_text: text,
    size_bytes: file.size,
  });
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new NextResponse("id required", { status: 400 });

  const { error } = await supabase
    .from("creator_analytics_uploads")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
