import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { decrypt } from "../../crypto";
import { getModel, isProvider } from "../../ai-providers";
import {
  buildToolsForIntegrations,
  loadIntegration,
  type IntegrationRow,
} from "../../tools";
import { buildVideoIdeasResearchTools } from "../../tools/video-ideas-research";
import { loadAccountContext, type AccountContext } from "./context";
import { unifiedPrompt } from "./prompts";
import { parseIdeas as parseIdeasFromText, SCHEMA_HINT } from "./parser";
import type { GeneratedIdea, VideoIdeaKind, VideoIdeasResult } from "./types";

// Unified multi-account video-ideas generator.
//
// Replaces the per-account runVideoIdeasAgent. Takes ALL the user's
// integration ids, loads each account's context in parallel, builds
// one prompt with per-account blocks, and asks the model to produce
// `totalCount` ideas across the whole network — each idea tagged with
// target_integration_ids[] and primary_integration_id.
//
// Single-account callers (the legacy /api/video-ideas/refresh route)
// can pass a single-element integrationIds array and this gracefully
// degrades — the per-account context still loads, the prompt still
// instructs aggressive-within-niche multi-targeting (which becomes a
// no-op with one account), and every idea targets the single account.
//
// Tools: built with the FULL integrations list so YT/TT/IG provider
// tools route via the `account` parameter (the recent multi-account
// refactor handles this). Research tools (find_similar_reviews +
// find_recent_feedback) take target_integration_id per call.

const IDEA_SCHEMA = z
  .object({
    title: z.string(),
    hook: z.string().nullish(),
    format: z.string().nullish(),
    rationale: z.string().nullish(),
    kind: z.enum(["pattern", "trend", "rising", "competitor", "seasonal"]),
    target_integration_ids: z.array(z.string().uuid()).min(1),
    primary_integration_id: z.string().uuid(),
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
          .object({ caption: z.string(), hashtags: z.array(z.string()) })
          .nullish(),
        youtube: z
          .object({
            title: z.string(),
            description: z.string(),
            hashtags: z.array(z.string()),
          })
          .nullish(),
        instagram: z
          .object({ caption: z.string(), hashtags: z.array(z.string()) })
          .nullish(),
      })
      .nullish(),
  })
  .refine(
    (i) => i.target_integration_ids.includes(i.primary_integration_id),
    {
      message:
        "primary_integration_id must be a member of target_integration_ids",
    },
  );

const IDEAS_ENVELOPE_SCHEMA = z.union([
  z.object({ ideas: z.array(IDEA_SCHEMA) }),
  z.array(IDEA_SCHEMA),
]);

const SUPPORTED_PROVIDERS = new Set(["tiktok", "youtube", "instagram"]);

// CRUD tools that exist for the chat agent to manage video_ideas rows
// directly. The generator must NOT see them or it'll prefer just
// calling video_ideas_create instead of producing JSON.
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

export async function runUnifiedVideoIdeasAgent({
  supabase,
  userId,
  integrationIds,
  totalCount,
  onStep,
}: {
  supabase: SupabaseClient;
  userId: string;
  integrationIds: string[];
  totalCount: number;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
}): Promise<VideoIdeasResult> {
  if (totalCount <= 0 || integrationIds.length === 0) {
    return { ok: true, ideas: [] };
  }

  // Resolve every requested integration. Drop unsupported/missing ones
  // so a single bad id doesn't kill the whole run.
  const integrations: IntegrationRow[] = [];
  for (const id of integrationIds) {
    const row = await loadIntegration(supabase, userId, id);
    if (!row) continue;
    if (!SUPPORTED_PROVIDERS.has(row.provider)) continue;
    integrations.push(row);
  }
  if (integrations.length === 0) {
    return {
      ok: false,
      error: "No supported integrations found for the requested ids.",
    };
  }

  // AI provider key.
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

  // Tools for ALL integrations — every provider tool routes by the
  // `account` parameter (multi-account refactor handles this).
  const { tools: rawTools, connected } = await buildToolsForIntegrations(
    supabase,
    userId,
    integrations,
  );

  // Strip CRUD tools (whitelist by exact name so future research tools
  // under the video_ideas_ prefix don't get accidentally stripped).
  const tools: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawTools)) {
    if (VIDEO_IDEAS_CRUD_TOOLS.has(name)) continue;
    tools[name] = value;
  }

  // Per-account research tools (scoped by target_integration_id at call
  // time). Pass ALL integration ids so the agent can target any.
  Object.assign(
    tools,
    buildVideoIdeasResearchTools(
      supabase,
      userId,
      integrations.map((i) => i.id),
    ),
  );

  // Load each account's context in parallel — reviews + feedback +
  // preferences. Each loader is defensive (returns empty on failure).
  const accounts: AccountContext[] = await Promise.all(
    integrations.map((i) => loadAccountContext(supabase, userId, i)),
  );

  const today = new Date().toISOString().slice(0, 10);
  const system = unifiedPrompt({ totalCount, today, accounts, connected });

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
          content: `Produce up to ${totalCount} fresh video ideas across the connected accounts now.`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      // Raised from 20 → 40 for multi-account runs. Budget covers
      // per-account research passes (5-7 calls × N accounts) plus
      // per-idea similar-reviews lookups (1 per idea × up to totalCount).
      // Single-account callers (legacy /refresh) sit well under 20 so
      // the higher cap is harmless.
      stopWhen: stepCountIs(40),
      onStepFinish: async (step) => {
        stepCount += 1;
        if (onStep) {
          try {
            await onStep({
              count: stepCount,
              description: describeStep(step),
            });
          } catch (err) {
            console.error("onStep failed:", err);
          }
        }
      },
    });

    let parsed = parseIdeasFromText(result.text, IDEAS_ENVELOPE_SCHEMA);
    let totalTokens = result.usage?.totalTokens ?? 0;

    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.warn(
        "[unified-agent] first parse failed, retrying as JSON-only reformat. raw:",
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
              content: `Convert the analysis below into video ideas as a JSON object matching this schema (note: every idea MUST have target_integration_ids and primary_integration_id):\n\n${SCHEMA_HINT}\n\nAnalysis to convert:\n\n${result.text}\n\nOutput the JSON only.`,
            },
          ],
        });
        parsed = parseIdeasFromText(retry.text, IDEAS_ENVELOPE_SCHEMA);
        totalTokens += retry.usage?.totalTokens ?? 0;
      } catch (err) {
        console.error("[unified-agent] retry call failed:", err);
      }
    }

    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.error(
        "[unified-agent] could not parse ideas after retry. raw:",
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
      ideas: parsed.slice(0, totalCount) as GeneratedIdea[],
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
// Re-exported here so the new generate route can import alongside the
// agent without round-tripping through the legacy module.
export const KIND_TTL_DAYS: Record<VideoIdeaKind, number> = {
  pattern: 30,
  competitor: 14,
  trend: 7,
  rising: 5,
  seasonal: 60,
};

// Structural type so callers can pass partial idea shapes (e.g. the
// evaluator's `{ kind, title, hard_date }` minimum). We only read
// kind + hard_date — the index signature lets callers include extra
// fields without TS object-literal excess-property errors.
export type ExpiryInput = {
  kind: VideoIdeaKind;
  hard_date?: string | null;
  [key: string]: unknown;
};

export function computeExpiresAt(idea: ExpiryInput, now = new Date()): Date {
  if (idea.kind === "seasonal" && idea.hard_date) {
    const d = new Date(idea.hard_date);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const days = KIND_TTL_DAYS[idea.kind];
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}
