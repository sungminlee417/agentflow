import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// PATCH supports: status (4-way enum) and/or priority (integer).
//
// Status promotion logic:
//   • When an idea is promoted to 'scheduled' AND no explicit
//     priority is provided, we auto-assign it to the end of the
//     queue: max(priority) + 10000 across the user/integration's
//     scheduled rows. The big gap leaves room for drag-and-drop
//     inserts without needing to rewrite neighbors.

const VALID_STATUSES = new Set(["pending", "scheduled", "done", "dismissed"]);
const PRIORITY_STEP = 10000;

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
    status?: string;
    priority?: number;
  } | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  if (body.status !== undefined && !VALID_STATUSES.has(body.status)) {
    return new NextResponse("Invalid status", { status: 400 });
  }

  const patch: Record<string, unknown> = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.priority !== undefined) patch.priority = body.priority;

  // Auto-assign a tail priority when promoting to 'scheduled' without
  // an explicit one — keeps the new pick at the bottom of the queue.
  if (body.status === "scheduled" && body.priority === undefined) {
    const { data: existing } = await supabase
      .from("video_ideas")
      .select("integration_id")
      .eq("id", id)
      .eq("user_id", user.id)
      .maybeSingle();
    if (existing) {
      const { data: maxRow } = await supabase
        .from("video_ideas")
        .select("priority")
        .eq("user_id", user.id)
        .eq("integration_id", existing.integration_id)
        .eq("status", "scheduled")
        .order("priority", { ascending: false })
        .limit(1)
        .maybeSingle();
      const next = (maxRow?.priority ?? 0) + PRIORITY_STEP;
      patch.priority = next;
    }
  }

  if (Object.keys(patch).length === 0) {
    return new NextResponse("Nothing to update", { status: 400 });
  }

  const { error } = await supabase
    .from("video_ideas")
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
    .from("video_ideas")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return new NextResponse(error.message, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
