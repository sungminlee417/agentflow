import { tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeExpiresAt, type VideoIdeaKind } from "../agents/video-ideas-agent";
import {
  runVideoReview,
  saveReview,
  extractTikTokVideoId,
} from "../agents/video-review-agent";
import {
  runEvaluateIdea,
  persistEvaluatedIdea,
} from "../agents/evaluate-idea-agent";

// Video-ideas CRUD tools for the chat agent.
//
// These let the chat directly read, create, edit, and curate the
// user's video-ideas library. Use case examples:
//   • "What do I have in my video ideas list?" — list
//   • "Show me the Hotel California one" — list + get
//   • "Rewrite the hook for that to be more provocative" — update
//   • "Add 3 new ideas in the same format as my top performers" —
//     fetch evidence with the tiktok_* tools, then create N rows
//   • "Mark all the Bach ones as scheduled" — list + set_status
//   • "Delete the off-niche ones" — list + delete
//
// All tools are scoped to the chatting user via RLS-like manual
// filtering on user_id, which double-protects on top of the RLS
// policies already on video_ideas. integration_id is required for
// create + list — it identifies which connected account the ideas
// belong to.

const KIND = z.enum(["pattern", "trend", "rising", "competitor", "seasonal"]);
const STATUS = z.enum(["pending", "scheduled", "done", "dismissed"]);

function normalizeHashtags(tags: string[] | null | undefined): string[] {
  return (tags ?? []).map((h) => h.replace(/^#/, "").trim()).filter(Boolean);
}

export function buildVideoIdeasTools(
  supabase: SupabaseClient,
  userId: string,
) {
  return {
    video_ideas_list_accounts: tool({
      description:
        "List the user's connected social-media accounts that can hold video ideas. Returns each account's id (use as `integration_id` in the other tools), provider (tiktok / youtube / instagram), and a human-readable name. Call this first if you need to know which account to act on.",
      inputSchema: z.object({}),
      execute: async () => {
        const { data } = await supabase
          .from("integrations")
          .select("id, provider, handle, display_name, account_label")
          .eq("user_id", userId)
          .order("created_at", { ascending: true });
        return (data ?? []).map((i) => ({
          id: i.id as string,
          provider: i.provider as string,
          name:
            (i.account_label as string | null) ||
            (i.display_name as string | null) ||
            (i.handle as string | null) ||
            "Account",
        }));
      },
    }),

    video_ideas_list: tool({
      description:
        "List the user's video ideas for a specific connected account. Defaults to status='pending'. Filter by kind ('pattern' | 'trend' | 'competitor' | 'seasonal') if you need a subset. Returns id, kind, status, title, hook (short preview), format, expires_at — call video_ideas_get for full content of one.",
      inputSchema: z.object({
        integration_id: z
          .string()
          .uuid()
          .describe("From video_ideas_list_accounts."),
        status: STATUS.default("pending"),
        kind: KIND.optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      execute: async ({ integration_id, status, kind, limit }) => {
        let query = supabase
          .from("video_ideas")
          .select(
            "id, kind, status, title, hook, format, expires_at, created_at",
          )
          .eq("user_id", userId)
          .eq("integration_id", integration_id)
          .eq("status", status)
          .order("created_at", { ascending: false })
          .limit(limit);
        if (kind) query = query.eq("kind", kind);
        const { data } = await query;
        return data ?? [];
      },
    }),

    video_ideas_get: tool({
      description:
        "Get the full content of a single video idea by id — title, hook, format, rationale, full script (with shot-by-shot SAY/ACTION/ON-SCREEN TEXT cues), post_title, description, hashtags, cta, visual_notes, source_refs. Use after video_ideas_list to inspect or edit one specifically.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        const { data } = await supabase
          .from("video_ideas")
          .select("*")
          .eq("user_id", userId)
          .eq("id", id)
          .maybeSingle();
        return data;
      },
    }),

    video_ideas_create: tool({
      description:
        "Create a new video idea in the user's library. integration_id, title, and kind are required. Provide as much upload-ready content as you can (script, hashtags, etc.) — the user expects to be able to shoot from the card. For 'seasonal' ideas you may also pass hard_date (ISO 8601) for when it should ship by. Expires_at is computed automatically from kind + hard_date.",
      inputSchema: z.object({
        integration_id: z.string().uuid(),
        title: z.string(),
        kind: KIND,
        hook: z.string().nullish(),
        format: z.string().nullish(),
        rationale: z.string().nullish(),
        source_refs: z.record(z.string(), z.unknown()).nullish(),
        hard_date: z
          .string()
          .nullish()
          .describe("ISO 8601 date — only meaningful when kind='seasonal'."),
        script: z.string().nullish(),
        post_title: z.string().nullish(),
        description: z.string().nullish(),
        hashtags: z.array(z.string()).nullish(),
        cta: z.string().nullish(),
        visual_notes: z.string().nullish(),
        optimal_post_window: z.string().nullish(),
        suggested_duration: z.string().nullish(),
        thumbnail_concept: z.string().nullish(),
        engagement_hook: z.string().nullish(),
        trending_sound: z.string().nullish(),
        saturation_warning: z.string().nullish(),
      }),
      execute: async (args) => {
        const { data: integ } = await supabase
          .from("integrations")
          .select("provider")
          .eq("user_id", userId)
          .eq("id", args.integration_id)
          .maybeSingle();
        if (!integ) {
          return { ok: false, error: "Integration not found." };
        }

        const expiresAt = computeExpiresAt({
          kind: args.kind as VideoIdeaKind,
          title: args.title,
          hard_date: args.hard_date ?? undefined,
        });

        const { data, error } = await supabase
          .from("video_ideas")
          .insert({
            user_id: userId,
            integration_id: args.integration_id,
            provider: (integ as { provider: string }).provider,
            title: args.title,
            kind: args.kind,
            hook: args.hook ?? null,
            format: args.format ?? null,
            rationale: args.rationale ?? null,
            source_refs: args.source_refs ?? {},
            expires_at: expiresAt.toISOString(),
            status: "pending",
            script: args.script ?? null,
            post_title: args.post_title ?? null,
            description: args.description ?? null,
            hashtags: normalizeHashtags(args.hashtags),
            cta: args.cta ?? null,
            visual_notes: args.visual_notes ?? null,
            optimal_post_window: args.optimal_post_window ?? null,
            suggested_duration: args.suggested_duration ?? null,
            thumbnail_concept: args.thumbnail_concept ?? null,
            engagement_hook: args.engagement_hook ?? null,
            trending_sound: args.trending_sound ?? null,
            saturation_warning: args.saturation_warning ?? null,
          })
          .select("id")
          .single();

        if (error) return { ok: false, error: error.message };
        return { ok: true, id: (data as { id: string }).id };
      },
    }),

    video_ideas_update: tool({
      description:
        "Update fields of an existing video idea. Any field you set is replaced; fields you omit are left alone. Useful for rewriting a hook ('make it more provocative'), swapping hashtags, polishing a script, etc. Returns ok + error.",
      inputSchema: z.object({
        id: z.string().uuid(),
        title: z.string().nullish(),
        hook: z.string().nullish(),
        format: z.string().nullish(),
        rationale: z.string().nullish(),
        script: z.string().nullish(),
        post_title: z.string().nullish(),
        description: z.string().nullish(),
        hashtags: z.array(z.string()).nullish(),
        cta: z.string().nullish(),
        visual_notes: z.string().nullish(),
        optimal_post_window: z.string().nullish(),
        suggested_duration: z.string().nullish(),
        thumbnail_concept: z.string().nullish(),
        engagement_hook: z.string().nullish(),
        trending_sound: z.string().nullish(),
      }),
      execute: async ({ id, ...fields }) => {
        const patch: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined) continue;
          if (k === "hashtags" && Array.isArray(v)) {
            patch[k] = normalizeHashtags(v as string[]);
          } else {
            patch[k] = v;
          }
        }
        if (Object.keys(patch).length === 0) {
          return { ok: false, error: "No fields to update." };
        }
        const { error } = await supabase
          .from("video_ideas")
          .update(patch)
          .eq("user_id", userId)
          .eq("id", id);
        return { ok: !error, error: error?.message };
      },
    }),

    video_ideas_set_status: tool({
      description:
        "Change an idea's status. 'pending' = default, in the active list. 'scheduled' = user plans to record it. 'done' = user has posted it. 'dismissed' = user rejected it (will be auto-pruned on next refresh).",
      inputSchema: z.object({
        id: z.string().uuid(),
        status: STATUS,
      }),
      execute: async ({ id, status }) => {
        const { error } = await supabase
          .from("video_ideas")
          .update({ status })
          .eq("user_id", userId)
          .eq("id", id);
        return { ok: !error, error: error?.message };
      },
    }),

    video_ideas_delete: tool({
      description:
        "Permanently delete a video idea by id. Use sparingly — usually setting status to 'dismissed' via video_ideas_set_status is the better call since it keeps audit info.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        const { error } = await supabase
          .from("video_ideas")
          .delete()
          .eq("user_id", userId)
          .eq("id", id);
        return { ok: !error, error: error?.message };
      },
    }),

    video_ideas_mark_posted: tool({
      description:
        "Link an idea to the actual video the user posted, mark the idea 'done', and schedule a performance review at +48h. Works for TikTok, YouTube, and Instagram — the platform is detected from the idea's source account. Accepts either the full URL (preferred — we parse the platform-specific id out) or the raw id. After this, the worker will pull stats + write a post-mortem automatically; the user can also trigger early review via video_ideas_run_review.",
      inputSchema: z.object({
        id: z.string().uuid(),
        posted_video_url: z.string().nullish(),
        posted_video_id: z.string().nullish(),
      }),
      execute: async ({ id, posted_video_url, posted_video_id }) => {
        // Resolve the platform from the idea's source integration so
        // we extract the right id shape. Fall back to TikTok parsing
        // when an explicit id was passed (legacy path).
        const { data: ideaRow } = await supabase
          .from("video_ideas")
          .select("provider")
          .eq("user_id", userId)
          .eq("id", id)
          .maybeSingle();
        const platform = (ideaRow?.provider as string | undefined) ?? "tiktok";
        const { extractPostedVideoId } = await import(
          "../agents/video-review-agent"
        );
        const videoId =
          posted_video_id ??
          extractPostedVideoId(platform, posted_video_url ?? "");
        if (!videoId) {
          return {
            ok: false,
            error: `Could not parse a ${platform} video id from the URL. Make sure you're passing the full link.`,
          };
        }
        const url =
          posted_video_url ??
          (platform === "tiktok"
            ? `https://www.tiktok.com/video/${videoId}`
            : platform === "youtube"
              ? `https://www.youtube.com/watch?v=${videoId}`
              : `https://www.instagram.com/reel/${videoId}/`);
        const postedAt = new Date();
        const nextReview = new Date(
          postedAt.getTime() + 48 * 60 * 60 * 1000,
        );
        const { error } = await supabase
          .from("video_ideas")
          .update({
            posted_video_id: videoId,
            posted_video_url: url,
            posted_at: postedAt.toISOString(),
            status: "done",
            next_review_at: nextReview.toISOString(),
            performance_verdict: null,
            performance_score: null,
            performance_review: null,
            performance_stats: null,
            last_reviewed_at: null,
          })
          .eq("user_id", userId)
          .eq("id", id);
        return {
          ok: !error,
          error: error?.message,
          posted_video_id: videoId,
          next_review_at: nextReview.toISOString(),
        };
      },
    }),

    video_ideas_evaluate: tool({
      description:
        "Evaluate a raw idea spark the user has typed (e.g. 'what if I do left-handed guitars?'). Pulls the creator's top performers + recent voice + niche context, returns a harsh-but-helpful verdict: 'add' (fits the pattern, fully fleshed idea returned), 'needs_work' (has potential but needs reframing — partial idea + specific reframing), or 'pass' (off-niche or contradicts what works — specific reason). Use when the user pitches you an idea in chat. If verdict is 'add' and add_if_good=true, the idea is inserted into the library automatically.",
      inputSchema: z.object({
        integration_id: z.string().uuid(),
        text: z.string().min(3),
        add_if_good: z.boolean().default(true),
      }),
      execute: async ({ integration_id, text, add_if_good }) => {
        const result = await runEvaluateIdea({
          supabase,
          userId,
          integrationId: integration_id,
          rawIdea: text,
        });
        if (!result.ok) return { ok: false, error: result.error };
        let added_id: string | undefined;
        if (add_if_good && result.verdict === "add" && result.idea) {
          const persisted = await persistEvaluatedIdea(
            supabase,
            userId,
            integration_id,
            result.idea,
          );
          if (!persisted.ok) {
            return { ok: false, error: persisted.error };
          }
          added_id = persisted.id;
        }
        return {
          ok: true,
          verdict: result.verdict,
          reasoning: result.reasoning,
          idea: result.idea,
          added_id,
        };
      },
    }),

    video_ideas_run_review: tool({
      description:
        "Run a performance review for a posted idea NOW (synchronously) — pulls the current TikTok stats, compares to the creator's baseline, classifies the outcome (hit / on_track / underperformed / too_early), and writes a markdown post-mortem. Idempotent — safe to re-run for a fresh reading. Requires the idea to already be linked via video_ideas_mark_posted.",
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => {
        const result = await runVideoReview({
          supabase,
          userId,
          ideaId: id,
        });
        if (!result.ok) {
          return { ok: false, error: result.error };
        }
        const saved = await saveReview(supabase, userId, id, result);
        if (!saved.ok) {
          return { ok: false, error: saved.error };
        }
        return {
          ok: true,
          verdict: result.verdict,
          score: result.score,
          stats: result.stats,
          review: result.review,
          next_review_at: result.next_review_at?.toISOString() ?? null,
        };
      },
    }),
  };
}
