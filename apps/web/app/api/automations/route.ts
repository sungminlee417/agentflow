import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// CRUD for the user's automations. Currently only one type is
// supported: 'github_issue_to_pr' with config { repo: "owner/name" }.

const VALID_TYPES = ["github_issue_to_pr"] as const;
type AutomationType = (typeof VALID_TYPES)[number];

function isValidType(t: string): t is AutomationType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data, error } = await supabase
    .from("automations")
    .select("id, type, config, enabled, last_run_at, created_at")
    .order("created_at", { ascending: false });
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ automations: data ?? [] });
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    type?: string;
    config?: Record<string, unknown>;
  } | null;
  if (!body?.type || !isValidType(body.type)) {
    return new NextResponse("Invalid automation type", { status: 400 });
  }
  if (body.type === "github_issue_to_pr") {
    const repo = body.config?.repo;
    if (typeof repo !== "string" || !/^[^/]+\/[^/]+$/.test(repo)) {
      return new NextResponse(
        'config.repo must be in "owner/name" form',
        { status: 400 },
      );
    }
  }

  const { error } = await supabase.from("automations").insert({
    user_id: user.id,
    type: body.type,
    config: body.config ?? {},
    enabled: true,
  });
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id) return new NextResponse("id is required", { status: 400 });

  const { error } = await supabase
    .from("automations")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    id?: string;
    enabled?: boolean;
  } | null;
  if (!body?.id || typeof body.enabled !== "boolean") {
    return new NextResponse("id and enabled required", { status: 400 });
  }

  const { error } = await supabase
    .from("automations")
    .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq("id", body.id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
