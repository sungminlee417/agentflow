import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Poll endpoint for a single generation job. Client polls every ~2s
// while the job is running, so the progress card stays live even
// after the SSE stream dropped (e.g. user navigated away and back).
//
// Self-heals stale 'running' rows: if a job hasn't been updated in
// 5+ minutes we flip it to 'failed' on read. Vercel max-duration is
// 60s so anything stuck for minutes is genuinely dead.

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data } = await supabase
    .from("video_ideas_generation_jobs")
    .select(
      "id, integration_id, status, step_count, step_label, requested_count, generated_count, error, started_at, updated_at, finished_at",
    )
    .eq("user_id", user.id)
    .eq("id", id)
    .maybeSingle();

  if (!data) return new NextResponse("Job not found", { status: 404 });

  if (
    data.status === "running" &&
    Date.now() - new Date(data.updated_at as string).getTime() >
      STALE_THRESHOLD_MS
  ) {
    const nowIso = new Date().toISOString();
    await supabase
      .from("video_ideas_generation_jobs")
      .update({
        status: "failed",
        error: "Generation stalled (no progress in 5+ minutes).",
        updated_at: nowIso,
        finished_at: nowIso,
      })
      .eq("id", id);
    return NextResponse.json({
      job: {
        ...data,
        status: "failed",
        error: "Generation stalled (no progress in 5+ minutes).",
        finished_at: nowIso,
      },
    });
  }

  return NextResponse.json({ job: data });
}
