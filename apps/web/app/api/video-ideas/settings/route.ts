import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Per-account video-ideas settings: target_count (how many pending
// ideas to keep around) + preferences (free-text constraints the
// agent respects when generating + evaluating).
//
// Caller passes integration_id plus any of {target_count, preferences}.
// Unset fields aren't touched. preferences=null clears it.

export async function PUT(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    integration_id?: string;
    target_count?: number;
    preferences?: string | null;
  } | null;
  if (!body?.integration_id) {
    return new NextResponse("Missing integration_id", { status: 400 });
  }

  // Verify ownership.
  const { data: integration } = await supabase
    .from("integrations")
    .select("id, provider")
    .eq("id", body.integration_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!integration) {
    return new NextResponse("Integration not found", { status: 404 });
  }

  // Read existing row so we can preserve fields the caller didn't pass.
  const { data: existing } = await supabase
    .from("video_ideas_settings")
    .select("target_count, preferences")
    .eq("user_id", user.id)
    .eq("integration_id", body.integration_id)
    .maybeSingle();

  const targetCount =
    body.target_count !== undefined
      ? Math.min(50, Math.max(1, Number(body.target_count)))
      : (existing?.target_count ?? 10);

  const preferences =
    body.preferences === undefined
      ? (existing?.preferences ?? null)
      : body.preferences === null
        ? null
        : String(body.preferences).slice(0, 4000);

  const { error } = await supabase.from("video_ideas_settings").upsert(
    {
      user_id: user.id,
      integration_id: body.integration_id,
      provider: integration.provider,
      target_count: targetCount,
      preferences,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,integration_id" },
  );

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({
    target_count: targetCount,
    preferences,
  });
}
