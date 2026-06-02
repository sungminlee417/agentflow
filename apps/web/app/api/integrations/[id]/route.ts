import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Rename an integration (set the user-editable account_label).

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
    account_label?: string | null;
  } | null;
  if (!body) return new NextResponse("Invalid body", { status: 400 });

  const label =
    typeof body.account_label === "string"
      ? body.account_label.slice(0, 80)
      : null;

  const { error } = await supabase
    .from("integrations")
    .update({ account_label: label, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) return new NextResponse(error.message, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
