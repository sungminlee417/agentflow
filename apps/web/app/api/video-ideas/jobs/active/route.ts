import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Returns the latest non-final generation job for an account, or null.
//
// "Active" = status='running' and updated within the last 5 minutes
// (stale jobs are auto-failed by reading the /[id] endpoint, but for
// this initial lookup we just hide them).
//
// Used by /video-ideas on page load to decide whether to show the
// progress card and start polling — survives navigation away.

export async function GET(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const integrationId = new URL(request.url).searchParams.get("integration_id");
  if (!integrationId) {
    return NextResponse.json({ error: "Missing integration_id" }, { status: 400 });
  }

  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from("video_ideas_generation_jobs")
    .select(
      "id, status, step_count, step_label, requested_count, generated_count, error, started_at, updated_at, finished_at",
    )
    .eq("user_id", user.id)
    .eq("integration_id", integrationId)
    .eq("status", "running")
    .gt("updated_at", fiveMinAgo)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return NextResponse.json({ job: data ?? null });
}
