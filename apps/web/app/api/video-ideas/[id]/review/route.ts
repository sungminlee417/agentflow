import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  runPostReview,
  runVideoReview,
  savePostReview,
  saveReview,
} from "@agentflow/core";

// Synchronously run a performance review. Used by the "Review now"
// button so the user can get an early peek without waiting for the
// worker's 48h tick. The worker runs the same code paths on its own
// schedule — calling this just runs it sooner.
//
// Two modes:
//   • With ?post_id=<uuid> in the query: review THAT specific
//     per-platform post (multi-platform model).
//   • Without ?post_id: review every per-platform post linked to
//     the idea — and, if no posts exist (legacy idea), fall back to
//     the single-row review on video_ideas.

export const maxDuration = 60;

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

  const postId = new URL(req.url).searchParams.get("post_id");

  // ── Single per-platform post ─────────────────────────────────────
  if (postId) {
    const result = await runPostReview({
      supabase,
      userId: user.id,
      postId,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error ?? "Review failed." },
        { status: 500 },
      );
    }
    const saved = await savePostReview(supabase, user.id, postId, result);
    if (!saved.ok) {
      return NextResponse.json(
        { error: saved.error ?? "Could not save review." },
        { status: 500 },
      );
    }
    return NextResponse.json({
      ok: true,
      verdict: result.verdict,
      score: result.score,
      stats: result.stats,
      next_review_at: result.next_review_at?.toISOString() ?? null,
    });
  }

  // ── All posts for this idea ──────────────────────────────────────
  const { data: posts } = await supabase
    .from("video_idea_posts")
    .select("id")
    .eq("user_id", user.id)
    .eq("idea_id", id);

  if (posts && posts.length > 0) {
    const reviews: Array<{
      post_id: string;
      verdict?: string;
      ratio?: number;
      error?: string;
    }> = [];
    for (const p of posts) {
      const pid = p.id as string;
      const result = await runPostReview({
        supabase,
        userId: user.id,
        postId: pid,
      });
      if (!result.ok) {
        reviews.push({ post_id: pid, error: result.error });
        continue;
      }
      await savePostReview(supabase, user.id, pid, result);
      reviews.push({
        post_id: pid,
        verdict: result.verdict,
        ratio: result.stats?.ratio,
      });
    }
    return NextResponse.json({ ok: true, reviews });
  }

  // ── Legacy single-post idea ──────────────────────────────────────
  const result = await runVideoReview({
    supabase,
    userId: user.id,
    ideaId: id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Review failed." },
      { status: 500 },
    );
  }
  const saved = await saveReview(supabase, user.id, id, result);
  if (!saved.ok) {
    return NextResponse.json(
      { error: saved.error ?? "Could not save review." },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    verdict: result.verdict,
    score: result.score,
    stats: result.stats,
    next_review_at: result.next_review_at?.toISOString() ?? null,
  });
}
