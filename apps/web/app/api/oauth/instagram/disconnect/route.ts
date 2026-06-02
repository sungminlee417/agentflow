import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const integrationId = new URL(request.url).searchParams.get("integration_id");

  let query = supabase
    .from("integrations")
    .delete()
    .eq("user_id", user.id)
    .eq("provider", "instagram");
  if (integrationId) query = query.eq("id", integrationId);

  const { error } = await query;
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
