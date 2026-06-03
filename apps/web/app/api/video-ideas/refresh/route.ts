import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeExpiresAt, runVideoIdeasAgent } from "@agentflow/core";

// Top-up refresh, account-scoped. Streams progress to the client as
// SSE so the UI can show "Step 5 · Searching #fingerstyle…" instead
// of a 60-second silent spinner.
//
// AND writes a persistent job row at every step. If the user navigates
// away from /video-ideas mid-generation, the SSE stream dies but the
// agent keeps running server-side and the job row keeps updating. The
// page re-attaches via polling /api/video-ideas/jobs/[id] on return.
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

  // Don't kick off a duplicate if one is already in flight for this
  // account. Saves the user from accidentally running two generations
  // (and from being billed twice).
  const { data: existingJob } = await supabase
    .from("video_ideas_generation_jobs")
    .select("id, started_at")
    .eq("user_id", user.id)
    .eq("integration_id", integrationId)
    .eq("status", "running")
    .gt("updated_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingJob) {
    return NextResponse.json(
      {
        error: "A generation is already running for this account.",
        job_id: existingJob.id,
      },
      { status: 409 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let clientGone = false;
      const send = (event: string, data: Record<string, unknown>) => {
        if (clientGone) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // Controller already closed — user navigated away. Stop
          // trying to send; the job row keeps updating from here.
          clientGone = true;
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed — ignore
        }
      };

      // Insert the job row up front so /jobs/active can find it
      // immediately, even before the first onStep fires.
      let jobId: string | null = null;
      const { data: jobRow } = await supabase
        .from("video_ideas_generation_jobs")
        .insert({
          user_id: user.id,
          integration_id: integrationId,
          status: "running",
          step_count: 0,
          step_label: "Starting…",
        })
        .select("id")
        .single();
      jobId = jobRow?.id ?? null;
      if (jobId) send("job", { id: jobId });

      async function updateJob(patch: Record<string, unknown>) {
        if (!jobId) return;
        await supabase
          .from("video_ideas_generation_jobs")
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq("id", jobId);
      }

      async function finalizeJob(
        status: "done" | "failed",
        patch: Record<string, unknown>,
      ) {
        if (!jobId) return;
        await supabase
          .from("video_ideas_generation_jobs")
          .update({
            ...patch,
            status,
            updated_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
          })
          .eq("id", jobId);
      }

      try {
        send("prepare", { label: "Checking what's expired…" });
        await updateJob({ step_label: "Checking what's expired…" });
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
          await finalizeJob("done", {
            generated_count: 0,
            step_label: "Already at target.",
          });
          close();
          return;
        }

        send("prepare", {
          label: `Generating ${deficit} new idea${deficit === 1 ? "" : "s"}…`,
        });
        await updateJob({
          requested_count: deficit,
          step_label: `Generating ${deficit} new idea${deficit === 1 ? "" : "s"}…`,
        });

        const result = await runVideoIdeasAgent({
          supabase,
          userId: user.id,
          integrationId,
          count: deficit,
          onStep: async ({ count, description }) => {
            const label = humanizeStep(description);
            send("step", { count, label });
            await updateJob({ step_count: count, step_label: label });
          },
        });

        if (!result.ok) {
          const err = result.error ?? "Agent failed.";
          send("error", { error: err });
          await finalizeJob("failed", { error: err });
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
          await updateJob({
            step_label: `Saving ${rows.length} idea${rows.length === 1 ? "" : "s"}…`,
          });
          const { error: insertErr } = await supabase
            .from("video_ideas")
            .insert(rows);
          if (insertErr) {
            const err = `Insert failed: ${insertErr.message}`;
            send("error", { error: err });
            await finalizeJob("failed", { error: err });
            close();
            return;
          }
        }

        send("done", {
          generated: rows.length,
          pending: (pendingCount ?? 0) + rows.length,
          tokens: result.tokens,
        });
        await finalizeJob("done", {
          generated_count: rows.length,
          step_label: `Generated ${rows.length} new idea${rows.length === 1 ? "" : "s"}.`,
        });
        close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        send("error", { error: msg });
        await finalizeJob("failed", { error: msg });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
