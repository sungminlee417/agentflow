import "@/lib/ai-bootstrap";
import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { reevaluateIdea } from "@agentflow/core";

// POST /api/video-ideas/[id]/reevaluate
//
// Thin route wrapper around the shared reevaluateIdea() helper in core
// (so the chat agent's video_ideas_reevaluate tool can share the same
// implementation). Audits the idea against per-account context and
// returns a verdict + reasoning + optional refined_fields the UI can
// apply via PATCH /api/video-ideas/[id].

export const maxDuration = 30;

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

  const result = await reevaluateIdea({
    supabase,
    userId: user.id,
    ideaId: id,
  });
  if (!result.ok) {
    const status =
      result.error === "Idea not found." ? 404 : 500;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({
    verdict: result.verdict,
    reasoning: result.reasoning,
    refined_fields: result.refined_fields,
  });
}
