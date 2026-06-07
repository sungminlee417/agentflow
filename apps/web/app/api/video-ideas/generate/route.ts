import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { computeExpiresAt, runUnifiedVideoIdeasAgent } from "@agentflow/core";

// Unified multi-account video-ideas generation.
//
// Body: { integration_ids?: string[], total_count?: number }
//   - integration_ids defaults to every connected supported integration
//     (TT/YT/IG) the user has.
//   - total_count defaults to 15.
//
// The agent sees ALL accounts at once, generates ideas across the user's
// network, and tags each idea with target_integration_ids[] +
// primary_integration_id. The route validates targets against the user's
// real integration set (drops hallucinated ids), writes the idea to
// video_ideas with primary_integration_id mirrored onto integration_id
// for back-compat, then writes one video_idea_targets row per target.
//
// Concurrency: rejected with 409 if ANY running job in
// video_ideas_generation_jobs overlaps with the requested integration_ids
// (overlap check uses the integration_ids array column added in
// migration 20260607000000).
//
// SSE event types:
//   • job       — { id }
//   • prepare   — { label }
//   • step      — { count, label }
//   • inserting — { generated }
//   • done      — { generated, by_account: Record<integrationId, number> }
//   • error     — { error }

export const maxDuration = 60;

const SUPPORTED_PROVIDERS = new Set(["tiktok", "youtube", "instagram"]);

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
  video_ideas_find_similar_reviews: "Pulling lessons from similar past posts",
  video_ideas_find_recent_feedback: "Checking what you've rejected before",
  youtube_get_my_channel: "Reading your YouTube channel",
  youtube_list_my_videos: "Reading your recent YouTube videos",
  youtube_get_video_analytics: "Pulling YouTube Analytics for a video",
  youtube_get_video_traffic_sources: "Checking YouTube traffic sources",
  youtube_search_niche: "Searching the YouTube niche",
  youtube_get_video_comments: "Reading audience comments",
  instagram_get_my_account: "Reading your Instagram account",
  instagram_list_my_media: "Reading your recent Instagram media",
  instagram_get_media_insights: "Pulling Instagram insights for a post",
  instagram_get_account_insights: "Pulling Instagram account insights",
  instagram_list_comments: "Reading Instagram comments",
  instagram_search_hashtag: "Searching Instagram hashtag",
  instagram_get_profile: "Inspecting an Instagram competitor",
};

function humanizeStep(raw: string): string {
  const m = /Calling\s+(\S+)/i.exec(raw);
  if (m && m[1]) return TOOL_LABELS[m[1]] ?? `Running ${m[1]}`;
  if (/draft|generat/i.test(raw)) return "Drafting your ideas";
  return raw;
}

type RawPlatforms = {
  tiktok?: { caption?: string | null; hashtags?: string[] | null } | null;
  youtube?: {
    title?: string | null;
    description?: string | null;
    hashtags?: string[] | null;
  } | null;
  instagram?: { caption?: string | null; hashtags?: string[] | null } | null;
};

function stripHash(h: string): string {
  return h.replace(/^#/, "");
}

function normalizePlatforms(p: RawPlatforms): RawPlatforms {
  const out: RawPlatforms = {};
  if (p.tiktok?.caption) {
    out.tiktok = {
      caption: p.tiktok.caption,
      hashtags: (p.tiktok.hashtags ?? []).map(stripHash),
    };
  }
  if (p.youtube?.title) {
    out.youtube = {
      title: p.youtube.title,
      description: p.youtube.description ?? "",
      hashtags: (p.youtube.hashtags ?? []).map(stripHash),
    };
  }
  if (p.instagram?.caption) {
    out.instagram = {
      caption: p.instagram.caption,
      hashtags: (p.instagram.hashtags ?? []).map(stripHash),
    };
  }
  return out;
}

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    integration_ids?: string[];
    total_count?: number;
  } | null;

  // Resolve the user's supported integrations. If the caller specified
  // integration_ids, filter to that subset; otherwise use all of them.
  const { data: allIntegrations } = await supabase
    .from("integrations")
    .select("id, provider")
    .eq("user_id", user.id);
  const supported = (allIntegrations ?? []).filter((i) =>
    SUPPORTED_PROVIDERS.has(i.provider as string),
  );
  let integrationIds: string[];
  if (body?.integration_ids && body.integration_ids.length > 0) {
    const requested = new Set(body.integration_ids);
    integrationIds = supported
      .filter((i) => requested.has(i.id as string))
      .map((i) => i.id as string);
  } else {
    integrationIds = supported.map((i) => i.id as string);
  }
  if (integrationIds.length === 0) {
    return NextResponse.json(
      { error: "No connected supported integrations." },
      { status: 400 },
    );
  }

  const totalCount = Math.max(
    1,
    Math.min(50, Math.round(body?.total_count ?? 15)),
  );

  // Concurrency guard: reject if ANY running job overlaps with this
  // request's integration set. Uses the GIN-indexed integration_ids
  // array column (migration 20260607000000).
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: runningJobs } = await supabase
    .from("video_ideas_generation_jobs")
    .select("id, integration_ids, integration_id")
    .eq("user_id", user.id)
    .eq("status", "running")
    .gt("updated_at", fiveMinAgo);
  const overlap = (runningJobs ?? []).find((j) => {
    const ids = ((j.integration_ids as string[] | null) ?? []).concat(
      j.integration_id ? [j.integration_id as string] : [],
    );
    return ids.some((id) => integrationIds.includes(id));
  });
  if (overlap) {
    return NextResponse.json(
      {
        error: "A generation is already running for one of these accounts.",
        job_id: overlap.id,
      },
      { status: 409 },
    );
  }

  // Validation set for target ids the agent emits.
  const validIntegrationIds = new Set(integrationIds);
  // Provider lookup for the back-compat video_ideas.provider column.
  const providerByIntegration = new Map<string, string>();
  for (const i of supported) {
    providerByIntegration.set(i.id as string, i.provider as string);
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
          clientGone = true;
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      // Insert the job row up front. integration_ids column tracks the
      // full target set; legacy integration_id is null for unified runs.
      let jobId: string | null = null;
      const { data: jobRow } = await supabase
        .from("video_ideas_generation_jobs")
        .insert({
          user_id: user.id,
          integration_id: null,
          integration_ids: integrationIds,
          status: "running",
          step_count: 0,
          step_label: "Starting…",
          requested_count: totalCount,
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
        send("prepare", {
          label: `Prepping ${integrationIds.length} account${integrationIds.length === 1 ? "" : "s"}…`,
        });
        await updateJob({ step_label: "Prepping accounts…" });

        // Prune expired + dismissed ideas across ALL targeted accounts
        // in a single round-trip.
        const nowIso = new Date().toISOString();
        await supabase
          .from("video_ideas")
          .delete()
          .eq("user_id", user.id)
          .in("integration_id", integrationIds)
          .or(`expires_at.lt.${nowIso},status.eq.dismissed`);

        send("prepare", {
          label: `Generating ${totalCount} idea${totalCount === 1 ? "" : "s"} across ${integrationIds.length} account${integrationIds.length === 1 ? "" : "s"}…`,
        });
        await updateJob({
          step_label: `Generating ${totalCount} ideas…`,
        });

        const result = await runUnifiedVideoIdeasAgent({
          supabase,
          userId: user.id,
          integrationIds,
          totalCount,
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

        // Validate + insert. For each idea: drop if any target is
        // unknown or primary not in targets; else insert video_ideas
        // (with integration_id = primary for back-compat) and one
        // video_idea_targets row per target.
        const byAccount: Record<string, number> = {};
        let inserted = 0;
        let droppedHallucinations = 0;

        if ((result.ideas?.length ?? 0) > 0) {
          send("inserting", { generated: result.ideas?.length ?? 0 });
          await updateJob({
            step_label: `Saving ${result.ideas?.length ?? 0} ideas…`,
          });
        }

        for (const idea of result.ideas ?? []) {
          const targets = (idea.target_integration_ids ?? []).filter((id) =>
            validIntegrationIds.has(id),
          );
          if (
            targets.length === 0 ||
            !validIntegrationIds.has(idea.primary_integration_id) ||
            !targets.includes(idea.primary_integration_id)
          ) {
            droppedHallucinations += 1;
            continue;
          }
          const primary = idea.primary_integration_id;
          const provider = providerByIntegration.get(primary) ?? "tiktok";
          const { data: insertedIdea, error: insertErr } = await supabase
            .from("video_ideas")
            .insert({
              user_id: user.id,
              integration_id: primary,
              provider,
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
              hashtags: (idea.hashtags ?? []).map(stripHash),
              cta: idea.cta ?? null,
              visual_notes: idea.visual_notes ?? null,
              optimal_post_window: idea.optimal_post_window ?? null,
              suggested_duration: idea.suggested_duration ?? null,
              thumbnail_concept: idea.thumbnail_concept ?? null,
              engagement_hook: idea.engagement_hook ?? null,
              trending_sound: idea.trending_sound ?? null,
              saturation_warning: idea.saturation_warning ?? null,
              video_format: idea.video_format ?? null,
              platforms: idea.platforms
                ? normalizePlatforms(idea.platforms)
                : null,
            })
            .select("id")
            .single();
          if (insertErr || !insertedIdea) {
            console.error(
              "[generate] insert video_ideas failed:",
              insertErr?.message,
            );
            continue;
          }

          const targetRows = targets.map((integrationId) => ({
            idea_id: insertedIdea.id as string,
            integration_id: integrationId,
            user_id: user.id,
            is_primary: integrationId === primary,
          }));
          const { error: targetsErr } = await supabase
            .from("video_idea_targets")
            .insert(targetRows);
          if (targetsErr) {
            console.error(
              "[generate] insert video_idea_targets failed:",
              targetsErr.message,
            );
            // Don't bail; the video_ideas row stands. Single-target
            // reads still work via the integration_id mirror.
          }

          inserted += 1;
          for (const t of targets) {
            byAccount[t] = (byAccount[t] ?? 0) + 1;
          }
        }

        if (droppedHallucinations > 0) {
          console.warn(
            `[generate] dropped ${droppedHallucinations} ideas with invalid target_integration_ids`,
          );
        }

        send("done", {
          generated: inserted,
          by_account: byAccount,
          tokens: result.tokens,
        });
        await finalizeJob("done", {
          generated_count: inserted,
          step_label: `Generated ${inserted} new idea${inserted === 1 ? "" : "s"}.`,
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
