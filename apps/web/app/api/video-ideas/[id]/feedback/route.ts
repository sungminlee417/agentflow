import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Thumbs-down feedback on a generated idea. Captures WHY the user
// rejected it so the next agent refresh can avoid the same failure
// mode. Crucially, the actionable fields (title/kind/format/hook) get
// DENORMALISED onto the feedback row — the parent idea row will be
// auto-pruned on next page load (status='dismissed' is deleted in
// app/(app)/video-ideas/page.tsx) and the FK cascade would lose the
// lesson otherwise.
//
// Distinct from /[id]/ PATCH dismiss: dismiss = "remove from queue,
// no judgment"; feedback = "this is wrong and here's why".

const VALID_REASONS = new Set([
  "outdated_trend",
  "wrong_voice",
  "flopped_before",
  "platform_wrong",
  "off_brand",
  "other",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    reason_code?: string;
    free_text?: string;
  } | null;
  if (!body?.reason_code || !VALID_REASONS.has(body.reason_code)) {
    return NextResponse.json(
      { error: `reason_code must be one of: ${[...VALID_REASONS].join(", ")}` },
      { status: 400 },
    );
  }

  // Load the idea so we can denormalise the snapshot. RLS makes this
  // safe — a user can only see their own ideas.
  const { data: idea } = await supabase
    .from("video_ideas")
    .select("id, integration_id, title, kind, format, hook")
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();
  if (!idea) return new NextResponse("Idea not found", { status: 404 });

  const { error: insertErr } = await supabase
    .from("video_idea_feedback")
    .insert({
      user_id: user.id,
      integration_id: idea.integration_id,
      idea_id: idea.id,
      idea_title: idea.title,
      idea_kind: idea.kind,
      idea_format: idea.format,
      idea_hook: idea.hook,
      reason_code: body.reason_code,
      free_text: body.free_text?.trim() || null,
    });
  if (insertErr) {
    return NextResponse.json(
      { error: `Could not save feedback: ${insertErr.message}` },
      { status: 500 },
    );
  }

  // Soft-dismiss the idea. It disappears from the master feed on next
  // page load (auto-prune); the feedback row's denormalised columns
  // keep the lesson alive past the cascade.
  await supabase
    .from("video_ideas")
    .update({ status: "dismissed" })
    .eq("user_id", user.id)
    .eq("id", id);

  return new NextResponse(null, { status: 204 });
}
