import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { extractTikTokVideoId } from "@agentflow/core";

// Link an idea to a posted TikTok video, mark it 'done', and schedule
// the first performance review for +48h. Accepts either:
//   • posted_video_url — a TikTok URL we parse a numeric id out of
//   • posted_video_id  — already-parsed numeric id (used by the
//                        auto-match flow which has the id in hand)
// Optionally accepts `unlink: true` to clear the link.

export async function PATCH(
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
    posted_video_url?: string;
    posted_video_id?: string;
    unlink?: boolean;
  } | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  if (body.unlink) {
    const { error } = await supabase
      .from("video_ideas")
      .update({
        posted_video_id: null,
        posted_video_url: null,
        posted_at: null,
        performance_verdict: null,
        performance_score: null,
        performance_review: null,
        performance_stats: null,
        last_reviewed_at: null,
        next_review_at: null,
      })
      .eq("user_id", user.id)
      .eq("id", id);
    if (error) return new NextResponse(error.message, { status: 500 });
    return new NextResponse(null, { status: 204 });
  }

  const videoId =
    body.posted_video_id ?? extractTikTokVideoId(body.posted_video_url ?? "");
  if (!videoId) {
    return NextResponse.json(
      {
        error:
          "Could not parse a video id from the URL. TikTok URLs look like https://www.tiktok.com/@user/video/1234567890.",
      },
      { status: 400 },
    );
  }

  const url =
    body.posted_video_url ??
    `https://www.tiktok.com/video/${videoId}`;

  // Schedule first review at +48h from now (or from create_time if we
  // had it — we don't, so wall-clock).
  const postedAt = new Date();
  const nextReview = new Date(postedAt.getTime() + 48 * 60 * 60 * 1000);

  const { error } = await supabase
    .from("video_ideas")
    .update({
      posted_video_id: videoId,
      posted_video_url: url,
      posted_at: postedAt.toISOString(),
      status: "done",
      next_review_at: nextReview.toISOString(),
      // Clear any prior review so we don't show stale data while the
      // new run is pending.
      performance_verdict: null,
      performance_score: null,
      performance_review: null,
      performance_stats: null,
      last_reviewed_at: null,
    })
    .eq("user_id", user.id)
    .eq("id", id);

  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({
    ok: true,
    posted_video_id: videoId,
    next_review_at: nextReview.toISOString(),
  });
}
