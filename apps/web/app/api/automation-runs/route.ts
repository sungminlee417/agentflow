import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Delete a single automation_runs row. RLS scopes by user, but we
// also enforce user_id in the where clause defensively.
//
// Deleting a row unsticks it: the next worker tick will see the
// issue as unhandled (no row exists) and retry. To "give up" on an
// issue, close it on GitHub instead.

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new NextResponse("id is required", { status: 400 });

  const { error } = await supabase
    .from("automation_runs")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
