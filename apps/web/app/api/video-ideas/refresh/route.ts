import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeExpiresAt, runVideoIdeasAgent } from "@agentflow/core";

// Top-up refresh, account-scoped. Streams progress to the client as
// SSE so the UI can show "Step 5 · Searching #fingerstyle…" instead
// of a 60-second silent spinner.
//
// Event types:
//   • prepare  — initial bookkeeping (prune expired, count pending)
//   • step     — { count, label } — the agent called a tool
//   • inserting — { generated } — about to write rows
//   • done     — { generated, pending } — success
//   • error    — { error }
//
// integration_id selects which connected account to generate ideas for.

export const maxDuration = 60;

// Human-friendly labels for the tool names the agent calls. Anything
// not in this map falls back to the raw name so we never lie about
// what's happening.
const TOOL_LABELS: Record<string, string> = {
  tiktok_get_my_profile: "Reading your profile",
  tiktok_list_my_videos: "Reading your recent videos",
  tiktok_top_my_videos: "Finding your lifetime top performers",
  tiktok_query_videos: "Looking up specific videos",
  tiktok_search_hashtag: "Searching trending hashtags",
  tiktok_search_keyword: "Searching trending topics",
  tiktok_get_profile: "Inspecting a competitor profile",
  tiktok_transcribe_video: "Transcribing a competitor video",
  list_my_analytics_uploads: "Reading your uploaded analytics",
  get_analytics_upload: "Reading an analytics file",
};

function humanizeStep(raw: string): string {
  const m = /Calling\s+(\S+)/i.exec(raw);
  if (m && m[1]) return TOOL_LABELS[m[1]] ?? `Running ${m[1]}`;
  if (/draft|generat/i.test(raw)) return "Drafting your ideas";
  return raw;
}

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed — ignore
        }
      };

      try {
        send("prepare", { label: "Checking what's expired…" });
        const nowIso = new Date().toISOString();
        await supabase
          .from("video_ideas")
          .delete()
          .eq("user_id", user.id)
          .eq("integration_id", integrationId)
          .or(`expires_at.lt.${nowIso},status.eq.dismissed`);

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
          send("done", {
            generated: 0,
            pending: pendingCount ?? 0,
            message: "Already at target.",
          });
          close();
          return;
        }

        send("prepare", {
          label: `Generating ${deficit} new idea${deficit === 1 ? "" : "s"}…`,
        });

        const result = await runVideoIdeasAgent({
          supabase,
          userId: user.id,
          integrationId,
          count: deficit,
          onStep: ({ count, description }) => {
            send("step", { count, label: humanizeStep(description) });
          },
        });

        if (!result.ok) {
          send("error", { error: result.error ?? "Agent failed." });
          close();
          return;
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
          optimal_post_window: idea.optimal_post_window ?? null,
          suggested_duration: idea.suggested_duration ?? null,
          thumbnail_concept: idea.thumbnail_concept ?? null,
          engagement_hook: idea.engagement_hook ?? null,
          trending_sound: idea.trending_sound ?? null,
        }));

        if (rows.length > 0) {
          send("inserting", { generated: rows.length });
          const { error: insertErr } = await supabase
            .from("video_ideas")
            .insert(rows);
          if (insertErr) {
            send("error", { error: `Insert failed: ${insertErr.message}` });
            close();
            return;
          }
        }

        send("done", {
          generated: rows.length,
          pending: (pendingCount ?? 0) + rows.length,
          tokens: result.tokens,
        });
        close();
      } catch (err) {
        send("error", {
          error: err instanceof Error ? err.message : String(err),
        });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable Vercel/Next response buffering — without this the
      // stream gets batched and the UI sees no updates until the end.
      "X-Accel-Buffering": "no",
    },
  });
}
