import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeExpiresAt, runVideoIdeasAgent } from "@agentflow/core";

// Top-up refresh, account-scoped. integration_id selects which
// connected account to generate ideas for.

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const body = (await request
    .json()
    .catch(() => null)) as { integration_id?: string } | null;
  const integrationId =
    body?.integration_id ?? url.searchParams.get("integration_id");
  if (!integrationId) {
    return NextResponse.json(
      { error: "Missing integration_id" },
      { status: 400 },
    );
  }

  // Verify ownership + capture provider.
  const { data: integration } = await supabase
    .from("integrations")
    .select("id, provider")
    .eq("id", integrationId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!integration) {
    return NextResponse.json(
      { error: "Integration not found." },
      { status: 404 },
    );
  }

  const nowIso = new Date().toISOString();

  // Prune expired + dismissed within this integration's pool.
  await supabase
    .from("video_ideas")
    .delete()
    .eq("user_id", user.id)
    .eq("integration_id", integrationId)
    .or(`expires_at.lt.${nowIso},status.eq.dismissed`);

  // Per-account settings.
  const { data: settingsRow } = await supabase
    .from("video_ideas_settings")
    .select("target_count")
    .eq("user_id", user.id)
    .eq("integration_id", integrationId)
    .maybeSingle();
  const targetCount = settingsRow?.target_count ?? 10;

  const { count: pendingCount } = await supabase
    .from("video_ideas")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("integration_id", integrationId)
    .eq("status", "pending");

  const deficit = Math.max(0, targetCount - (pendingCount ?? 0));
  if (deficit === 0) {
    return NextResponse.json({
      generated: 0,
      pending: pendingCount ?? 0,
      message: "Already at target.",
    });
  }

  const result = await runVideoIdeasAgent({
    supabase,
    userId: user.id,
    integrationId,
    count: deficit,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error ?? "Agent failed." },
      { status: 500 },
    );
  }

  const rows = (result.ideas ?? []).map((idea) => ({
    user_id: user.id,
    integration_id: integrationId,
    provider: integration.provider,
    title: idea.title,
    hook: idea.hook ?? null,
    format: idea.format ?? null,
    rationale: idea.rationale ?? null,
    kind: idea.kind,
    source_refs: idea.source_refs ?? {},
    expires_at: computeExpiresAt(idea).toISOString(),
    status: "pending",
    script: idea.script ?? null,
    post_title: idea.post_title ?? null,
    description: idea.description ?? null,
    hashtags: (idea.hashtags ?? []).map((h) => h.replace(/^#/, "")),
    cta: idea.cta ?? null,
    visual_notes: idea.visual_notes ?? null,
  }));

  if (rows.length > 0) {
    const { error: insertErr } = await supabase
      .from("video_ideas")
      .insert(rows);
    if (insertErr) {
      return NextResponse.json(
        { error: `Insert failed: ${insertErr.message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    generated: rows.length,
    pending: (pendingCount ?? 0) + rows.length,
    tokens: result.tokens,
  });
}
