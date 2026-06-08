import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// PATCH /api/inbox/[id]
//   • { draft_text }   — user edited the AI draft
//   • { status: "dismissed" } — user dismissed without replying

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
    draft_text?: string;
    status?: string;
  } | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof body.draft_text === "string") {
    patch.draft_text = body.draft_text;
  }
  if (body.status === "dismissed") {
    patch.status = "dismissed";
  } else if (body.status !== undefined) {
    return new NextResponse("Invalid status (only 'dismissed' allowed here)", {
      status: 400,
    });
  }
  if (Object.keys(patch).length === 1) {
    return new NextResponse("Nothing to update", { status: 400 });
  }

  const { error } = await supabase
    .from("comment_replies")
    .update(patch)
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return new NextResponse(null, { status: 204 });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { error } = await supabase
    .from("comment_replies")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
