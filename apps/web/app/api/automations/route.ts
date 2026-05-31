import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  AUTOMATION_TYPES,
  SCHEDULE_OPTIONS,
  type AutomationKind,
  type AutomationSchedule,
} from "@agentflow/core";

const VALID_TYPES = new Set(AUTOMATION_TYPES.map((m) => m.type));

function isValidType(t: string): t is AutomationKind {
  return VALID_TYPES.has(t as AutomationKind);
}

function isValidSchedule(s: string): s is AutomationSchedule {
  return (SCHEDULE_OPTIONS as readonly string[]).includes(s);
}

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data, error } = await supabase
    .from("automations")
    .select("id, type, config, enabled, schedule, last_run_at, created_at")
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
    schedule?: string;
  } | null;
  if (!body?.type || !isValidType(body.type)) {
    return new NextResponse("Invalid automation type", { status: 400 });
  }
  const schedule: AutomationSchedule =
    body.schedule && isValidSchedule(body.schedule) ? body.schedule : "manual";

  // Type-specific config validation.
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
    schedule,
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
    schedule?: string;
  } | null;
  if (!body?.id) {
    return new NextResponse("id required", { status: 400 });
  }
  const update: { enabled?: boolean; schedule?: AutomationSchedule; updated_at: string } = {
    updated_at: new Date().toISOString(),
  };
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (body.schedule && isValidSchedule(body.schedule)) {
    update.schedule = body.schedule;
  }

  const { error } = await supabase
    .from("automations")
    .update(update)
    .eq("id", body.id)
    .eq("user_id", user.id);
  if (error) return new NextResponse(error.message, { status: 500 });
  return NextResponse.json({ ok: true });
}
