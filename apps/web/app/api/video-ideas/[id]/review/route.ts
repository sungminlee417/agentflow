import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { runVideoReview, saveReview } from "@agentflow/core";

// Synchronously run a performance review for one idea. Used by the
// "Review now" button so the user can get an early peek without
// waiting for the worker's 48h tick.
//
// The worker runs the same code path on its own schedule — calling
// this just runs it sooner.

export const maxDuration = 60;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const result = await runVideoReview({ supabase, userId: user.id, ideaId: id });
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
