import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { buildToolsForIntegrations, loadIntegration } from "../tools";
import { buildVideoIdeasResearchTools } from "../tools/video-ideas-research";
import {
  instagramPrompt,
  tiktokPrompt,
  youtubePrompt,
} from "./video-ideas/prompts";
import type {
  GeneratedIdea,
  RecentFeedback,
  RecentReview,
  VideoIdeaKind,
  VideoIdeasResult,
} from "./video-ideas/types";
import {
  parseIdeas as parseIdeasFromText,
  SCHEMA_HINT,
} from "./video-ideas/parser";

// Re-export the shared types so the existing public API
// (@agentflow/core) keeps working — callers import these from this
// module's wildcard re-export.
export type {
  GeneratedIdea,
  PlatformPack,
  VideoIdeaKind,
  VideoIdeasResult,
} from "./video-ideas/types";

// Generates a balanced batch of fresh video ideas across four "kinds":
//   • pattern    — extrapolated from the user's own top performers
//   • competitor — a song/format a niche peer hit with, that the user
//                  hasn't covered
//   • trend      — a hashtag or sound currently trending in the niche
//   • seasonal   — calendar-anchored idea (holiday, anniversary)
//
// The agent calls its own tools (the same set as the chat agent) to
// gather evidence, then returns a JSON array of ideas. The caller
// (refresh API) decides expires_at per kind and inserts to DB.


const IDEA_SCHEMA = z.object({
  title: z.string(),
  hook: z.string().nullish(),
  format: z.string().nullish(),
  rationale: z.string().nullish(),
  kind: z.enum(["pattern", "trend", "rising", "competitor", "seasonal"]),
  source_refs: z.record(z.string(), z.unknown()).nullish(),
  hard_date: z.string().nullish(),
  saturation_warning: z.string().nullish(),
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
  video_format: z.enum(["short", "long"]).nullish(),
  platforms: z
    .object({
      tiktok: z
        .object({
          caption: z.string(),
          hashtags: z.array(z.string()),
        })
        .nullish(),
      youtube: z
        .object({
          title: z.string(),
          description: z.string(),
          hashtags: z.array(z.string()),
        })
        .nullish(),
      instagram: z
        .object({
          caption: z.string(),
          hashtags: z.array(z.string()),
        })
        .nullish(),
    })
    .nullish(),
});

// Accept either { ideas: [...] } or a bare [...].
const IDEAS_ENVELOPE_SCHEMA = z.union([
  z.object({ ideas: z.array(IDEA_SCHEMA) }),
  z.array(IDEA_SCHEMA),
]);


export async function runVideoIdeasAgent({
  supabase,
  userId,
  integrationId,
  count,
  onStep,
  targetPlatforms,
}: {
  supabase: SupabaseClient;
  userId: string;
  /** Which specific connected account this run is for. */
  integrationId: string;
  count: number;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
  /** Platforms to produce caption packages for. The source-integration
   *  platform should be first. Defaults to ["tiktok"] for callers that
   *  haven't been updated yet. */
  targetPlatforms?: string[];
}): Promise<VideoIdeasResult> {
  if (count <= 0) {
    return { ok: true, ideas: [] };
  }

  const integration = await loadIntegration(supabase, userId, integrationId);
  if (!integration) {
    return { ok: false, error: "Integration not found." };
  }
  const SUPPORTED = new Set(["tiktok", "youtube", "instagram"]);
  if (!SUPPORTED.has(integration.provider)) {
    return {
      ok: false,
      error: `Unsupported provider: ${integration.provider}`,
    };
  }

  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, encrypted_key, model")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (!keys || keys.length === 0) {
    return { ok: false, error: "No AI provider key configured." };
  }
  const { provider: aiProvider, encrypted_key, model: userModel } = keys[0]!;
  if (!isProvider(aiProvider)) {
    return { ok: false, error: `Unknown AI provider: ${aiProvider}` };
  }

  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch (err) {
    return {
      ok: false,
      error: `Could not decrypt API key: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // Scope tools to THIS specific integration so the agent doesn't
  // accidentally read another account's videos.
  const { tools: rawTools, connected } = await buildToolsForIntegrations(
    supabase,
    userId,
    [integration],
  );
  if (!connected.includes(integration.provider)) {
    return {
      ok: false,
      error: `${integration.provider} integration not connected.`,
    };
  }

  // buildToolsForIntegrations bundles the chat-agent's CRUD tools for
  // managing video_ideas (list/create/update/etc.) AND
  // video_ideas_list_accounts. The generator must NOT see those —
  // video_ideas_list_accounts in particular lets the model enumerate
  // every account the user has, which prompts it to ask clarifying
  // questions like "which account am I generating for, sungminlee or
  // Hammy?" instead of producing JSON.
  //
  // Whitelist by exact name (not prefix) so future research tools
  // added under the `video_ideas_` prefix don't get accidentally
  // stripped — the previous prefix-based strip ate
  // video_ideas_find_similar_reviews and forced a noisy re-mount.
  const VIDEO_IDEAS_CRUD_TOOLS = new Set([
    "video_ideas_list_accounts",
    "video_ideas_list",
    "video_ideas_get",
    "video_ideas_create",
    "video_ideas_update",
    "video_ideas_set_status",
    "video_ideas_delete",
    "video_ideas_mark_posted",
    "video_ideas_evaluate",
    "video_ideas_run_review",
  ]);
  const tools: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawTools)) {
    if (VIDEO_IDEAS_CRUD_TOOLS.has(name)) continue;
    tools[name] = value;
  }

  // Mount the per-idea research tools (find_similar_reviews +
  // find_recent_feedback) — these are NOT part of
  // buildToolsForIntegrations because they need to be scoped to the
  // specific integration being refreshed for, not the user globally.
  Object.assign(
    tools,
    buildVideoIdeasResearchTools(supabase, userId, integrationId),
  );

  // Pull recent post-mortems for this account. Queries through
  // video_idea_posts (rather than video_ideas) so EVERY settled
  // review feeds the learning loop — imported videos, single-platform
  // posts, and multi-platform posts alike. Joins via the idea_id FK
  // to pick up title/kind/format from the parent idea row.
  //
  // Skips too_early verdicts (the +48h pass before stats stabilise)
  // since their signal is noisy. One row per (post × verdict) — a
  // multi-platform shoot contributes one entry per platform so the
  // agent sees divergence ("TikTok hit, IG flop").
  const recentReviews: RecentReview[] = [];
  try {
    const { data: reviewed } = await supabase
      .from("video_idea_posts")
      .select(
        "platform, performance_verdict, performance_stats, performance_review, last_reviewed_at, video_ideas!inner(title, kind, format)",
      )
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .not("performance_verdict", "is", null)
      .neq("performance_verdict", "too_early")
      .order("last_reviewed_at", { ascending: false })
      .limit(8);
    type ReviewedRow = {
      platform: string | null;
      performance_verdict: string | null;
      performance_stats: { ratio?: number } | null;
      performance_review: string | null;
      // Supabase's typed select returns nested relations as either an
      // object (FK) or array (1:M). idea_id is a regular FK so this
      // is single-object — but the generated types still type it as
      // an array in some configs. Accept either shape.
      video_ideas:
        | { title?: string; kind?: string; format?: string | null }
        | Array<{ title?: string; kind?: string; format?: string | null }>
        | null;
    };
    for (const row of (reviewed ?? []) as unknown as ReviewedRow[]) {
      const idea = Array.isArray(row.video_ideas)
        ? row.video_ideas[0]
        : row.video_ideas;
      if (!idea?.title || !idea.kind) continue;
      // Extract the "Takeaways for the next video" bullets — that's
      // the actionable part for future generation.
      let takeaways: string | null = null;
      if (row.performance_review) {
        const tIdx = row.performance_review.indexOf("Takeaways");
        if (tIdx >= 0) {
          takeaways = row.performance_review
            .slice(tIdx)
            .replace(/^[#\s]*Takeaways[^\n]*\n?/, "")
            .trim()
            .slice(0, 400);
        }
      }
      recentReviews.push({
        title: idea.title,
        kind: idea.kind,
        format: idea.format ?? null,
        platform: row.platform ?? null,
        verdict: row.performance_verdict,
        ratio: row.performance_stats?.ratio ?? null,
        takeaways,
      });
    }
  } catch (err) {
    console.error("[video-ideas-agent] failed to load recent reviews:", err);
  }

  // Recent thumbs-down rejections for this account. Loaded with the
  // same pattern as recentReviews — denormalised columns on the
  // feedback row survive the parent idea's deletion (dismissal +
  // page-load prune).
  const recentFeedback: RecentFeedback[] = [];
  try {
    const { data: feedbackRows } = await supabase
      .from("video_idea_feedback")
      .select(
        "idea_title, idea_kind, idea_format, idea_hook, reason_code, free_text",
      )
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .order("created_at", { ascending: false })
      .limit(15);
    for (const row of (feedbackRows ?? []) as Array<{
      idea_title: string;
      idea_kind: string;
      idea_format: string | null;
      idea_hook: string | null;
      reason_code: string;
      free_text: string | null;
    }>) {
      recentFeedback.push({
        title: row.idea_title,
        kind: row.idea_kind,
        format: row.idea_format,
        hook: row.idea_hook,
        reason_code: row.reason_code,
        free_text: row.free_text,
      });
    }
  } catch (err) {
    console.error("[video-ideas-agent] failed to load recent feedback:", err);
  }

  // Per-account preferences (free-text constraints the creator set).
  let preferences: string | null = null;
  try {
    const { data: settingsRow } = await supabase
      .from("video_ideas_settings")
      .select("preferences")
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .maybeSingle();
    preferences =
      (settingsRow?.preferences as string | null | undefined) ?? null;
  } catch (err) {
    console.error("[video-ideas-agent] failed to load preferences:", err);
  }

  const today = new Date().toISOString().slice(0, 10);
  // Each integration generates ONLY for its own platform. Cross-
  // posting is now an opt-in downstream behaviour (the Mark-Done modal
  // can still link a single idea to posts on multiple platforms) — at
  // generation time the agent stays focused on the source platform.
  void targetPlatforms;
  let system: string;
  if (integration.provider === "youtube") {
    system = youtubePrompt(
      count,
      today,
      recentReviews,
      recentFeedback,
      preferences,
    );
  } else if (integration.provider === "instagram") {
    system = instagramPrompt(
      count,
      today,
      connected,
      recentReviews,
      recentFeedback,
      preferences,
    );
  } else {
    system = tiktokPrompt(
      count,
      today,
      connected,
      recentReviews,
      recentFeedback,
      preferences,
      [integration.provider],
    );
  }

  let stepCount = 0;
  try {
    const result = await generateText({
      model: getModel(aiProvider, apiKey, userModel),
      system,
      providerOptions:
        aiProvider === "anthropic"
          ? { anthropic: { cacheControl: { type: "ephemeral" } } }
          : undefined,
      messages: [
        {
          role: "user",
          content: `Produce ${count} fresh TikTok video ideas now.`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      // Bounded at 20 steps. Budget covers the base research pass
      // (profile / list / top / niche search / analytics ≈ 5-7 calls)
      // plus one video_ideas_find_similar_reviews call per idea the
      // model is considering (up to 10). Beyond 20 the model is
      // usually doing redundant searches rather than adding signal.
      stopWhen: stepCountIs(20),
      onStepFinish: async (step) => {
        stepCount += 1;
        if (onStep) {
          try {
            await onStep({ count: stepCount, description: describeStep(step) });
          } catch (err) {
            console.error("onStep failed:", err);
          }
        }
      },
    });

    let parsed = parseIdeasFromText(result.text, IDEAS_ENVELOPE_SCHEMA);
    let totalTokens = result.usage?.totalTokens ?? 0;

    // Parse-failure retry. Sonnet sometimes ignores the JSON-only
    // instruction and emits a narrative "Here's my analysis…" instead.
    // Rather than throw away the whole run (which already paid for
    // all the tool calls), feed the narrative back and ask for JSON
    // only. No tools, no system context bloat — just reformat what's
    // already in the assistant turn.
    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.warn(
        "[video-ideas-agent] first parse failed, retrying as JSON-only reformat. raw:",
        preview,
      );
      try {
        const retry = await generateText({
          model: getModel(aiProvider, apiKey, userModel),
          system:
            "You convert content-strategy analyses into a strict JSON schema. Your FINAL response is the JSON object only — no prose, no markdown, no code fence. Start with `{` and end with `}`.",
          messages: [
            {
              role: "user",
              content: `Convert the analysis below into exactly ${count} video ideas as a JSON object matching this schema:\n\n${SCHEMA_HINT}\n\nAnalysis to convert:\n\n${result.text}\n\nOutput the JSON only.`,
            },
          ],
        });
        parsed = parseIdeasFromText(retry.text, IDEAS_ENVELOPE_SCHEMA);
        totalTokens += retry.usage?.totalTokens ?? 0;
      } catch (err) {
        console.error("[video-ideas-agent] retry call failed:", err);
      }
    }

    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.error(
        "[video-ideas-agent] could not parse ideas after retry. raw:",
        preview,
      );
      return {
        ok: false,
        error: `Agent did not return valid JSON ideas. Preview: ${preview}`,
        tokens: totalTokens || undefined,
      };
    }

    return {
      ok: true,
      ideas: parsed.slice(0, count) as GeneratedIdea[],
      tokens: totalTokens || undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeStep(step: any): string {
  const toolCalls = step?.toolCalls ?? [];
  if (toolCalls.length === 0) return "Generating ideas";
  const last = toolCalls[toolCalls.length - 1];
  return `Calling ${String(last?.toolName ?? "tool")}`;
}

// Map kind → days until expiry. Seasonal uses hard_date instead.
export const KIND_TTL_DAYS: Record<VideoIdeaKind, number> = {
  pattern: 30,
  competitor: 14,
  trend: 7,
  rising: 5, // shorter than trend — rising signal degrades fast
  seasonal: 60, // fallback if hard_date is missing
};

export function computeExpiresAt(idea: GeneratedIdea, now = new Date()): Date {
  if (idea.kind === "seasonal" && idea.hard_date) {
    const d = new Date(idea.hard_date);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const days = KIND_TTL_DAYS[idea.kind];
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
