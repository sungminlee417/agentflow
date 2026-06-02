import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function PUT(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    target_count?: number;
    provider?: string;
  } | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  const targetCount = Math.min(
    50,
    Math.max(1, Number(body.target_count ?? 10)),
  );
  const provider = body.provider === "tiktok" ? "tiktok" : "tiktok";

  const { error } = await supabase
    .from("video_ideas_settings")
    .upsert({
      user_id: user.id,
      target_count: targetCount,
      provider,
      updated_at: new Date().toISOString(),
    });

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ target_count: targetCount, provider });
}
