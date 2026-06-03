import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { buildToolsForIntegrations, loadIntegration } from "../tools";
import {
  computeExpiresAt,
  type GeneratedIdea,
  type VideoIdeaKind,
} from "./video-ideas-agent";

// User-submitted idea evaluator.
//
// The user dumps a raw idea ("what if I do left-handed guitars?") and
// we ask the agent to:
//   1. Pull the creator's top performers + recent voice for context
//   2. Optionally check recent reviews — has anything similar been
//      tried, and how did it go?
//   3. Score the idea against the creator's pattern
//   4. Return either a fully-fleshed idea (with all the upload-ready
//      fields) ready to add, or a "pass" verdict with a specific
//      reason the user can act on
//
// Same generator quality bar as the bulk refresh — the user shouldn't
// notice a quality drop just because they typed the spark themselves.

export type EvaluationVerdict = "add" | "needs_work" | "pass";

export type EvaluationResult = {
  ok: boolean;
  verdict?: EvaluationVerdict;
  reasoning?: string;
  idea?: GeneratedIdea;
  tokens?: number;
  error?: string;
};

const EVALUATION_SCHEMA = z.object({
  verdict: z.enum(["add", "needs_work", "pass"]),
  reasoning: z.string(),
  idea: z
    .object({
      title: z.string(),
      hook: z.string().nullish(),
      format: z.string().nullish(),
      rationale: z.string().nullish(),
      kind: z.enum(["pattern", "trend", "competitor", "seasonal"]),
      source_refs: z.record(z.string(), z.unknown()).nullish(),
      hard_date: z.string().nullish(),
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
    })
    .nullish(),
});

function buildPrompt(args: {
  rawIdea: string;
  today: string;
  hasApify: boolean;
  preferences: string | null;
}): string {
  const prefBlock =
    args.preferences && args.preferences.trim()
      ? `

CREATOR PREFERENCES / HARD CONSTRAINTS (an idea that violates any of these is an automatic "pass", regardless of niche fit):
${args.preferences.trim()}`
      : "";

  return `You evaluate raw video-idea sparks the creator types in, and decide whether they fit. Your job is harsh-but-helpful filtering: most ideas should NOT make it into the library; only ones the creator's audience would actually reward should.

Today is ${args.today}.

User's raw idea spark:
"${args.rawIdea}"${prefBlock}

Required procedure:
1. tiktok_top_my_videos (top_n 10, from_history 100) — what hits for this creator.
2. tiktok_list_my_videos (max_count 20) — current voice.
3. ${args.hasApify ? "tiktok_search_hashtag on the creator's primary niche hashtag (limit 10) to see what's working in the space right now." : "(Apify not configured — judge from the creator's own data only.)"}
4. Compare the spark against what works for this creator's audience. Be SPECIFIC about why it does or doesn't fit.

Verdict rules:
- "add" → it clearly fits the creator's winning pattern, you have a concrete plan, and you're confident it would perform on par with or above their median. Fully flesh out the idea (every upload-ready field, every virality field).
- "needs_work" → the spark has potential but needs reframing to fit. Provide a SPECIFIC reframing in reasoning, and partially fill the idea (title + format + rationale + a couple of fields). Skip script/full content — the user should iterate before you commit to those.
- "pass" → it's off-niche or contradicts what works for this creator. State the specific reason ("your top 10 are all comparison hooks; solo performance of an obscure piece would underperform your median by 40-60% based on the post-mortems above"). Do NOT include the idea object in the response.

Return EXACTLY this JSON object and nothing else:
{
  "verdict": "add" | "needs_work" | "pass",
  "reasoning": string,  // 2-3 sentences max, grounded in actual tool data
  "idea": { ... } | null  // present for "add" (fully fleshed) or "needs_work" (partial); null for "pass"
}

If verdict is "add", the idea object must include EVERY field that the bulk video-ideas-agent produces: title, hook, format, rationale, kind, source_refs, script (shot-by-shot with SAY/ACTION/ON-SCREEN TEXT cues), post_title, description, hashtags (no leading #), cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound (or null). Match the creator's voice from their actual videos. Never invent stats or hashtags.

Return ONLY the JSON. No preamble, no code fence.`;
}

function parseEvaluation(text: string): EvaluationResult | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  // Try the whole thing first, then extract the first balanced object.
  const candidates = [cleaned];
  const objStart = cleaned.indexOf("{");
  if (objStart >= 0) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = objStart; i < cleaned.length; i++) {
      const c = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          candidates.push(cleaned.slice(objStart, i + 1));
          break;
        }
      }
    }
  }
  for (const c of candidates) {
    try {
      const parsed = EVALUATION_SCHEMA.safeParse(JSON.parse(c));
      if (!parsed.success) continue;
      return {
        ok: true,
        verdict: parsed.data.verdict,
        reasoning: parsed.data.reasoning,
        idea: parsed.data.idea
          ? (parsed.data.idea as GeneratedIdea)
          : undefined,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

export async function runEvaluateIdea({
  supabase,
  userId,
  integrationId,
  rawIdea,
}: {
  supabase: SupabaseClient;
  userId: string;
  integrationId: string;
  rawIdea: string;
}): Promise<EvaluationResult> {
  const trimmed = rawIdea.trim();
  if (!trimmed) return { ok: false, error: "Idea is empty." };

  const integration = await loadIntegration(supabase, userId, integrationId);
  if (!integration) return { ok: false, error: "Integration not found." };
  if (integration.provider !== "tiktok") {
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
  } catch {
    return { ok: false, error: "Could not decrypt AI provider key." };
  }

  const { tools, connected } = await buildToolsForIntegrations(
    supabase,
    userId,
    [integration],
  );
  if (!connected.includes("tiktok")) {
    return { ok: false, error: "TikTok integration not connected." };
  }

  // Per-account preferences (free-text constraints).
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
    console.error("[evaluate-idea-agent] failed to load preferences:", err);
  }

  const today = new Date().toISOString().slice(0, 10);
  const system = buildPrompt({
    rawIdea: trimmed,
    today,
    hasApify: connected.includes("apify"),
    preferences,
  });

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
          content: `Evaluate this idea now: "${trimmed}"`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      stopWhen: stepCountIs(15),
    });
    const parsed = parseEvaluation(result.text);
    if (!parsed) {
      return {
        ok: false,
        error: "Agent did not return a valid evaluation JSON.",
        tokens: result.usage?.totalTokens ?? undefined,
      };
    }
    return {
      ...parsed,
      tokens: result.usage?.totalTokens ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Persist an "add" verdict's fleshed idea to the database. Reuses the
// same insert shape as the refresh route so both code paths produce
// identical rows.
export async function persistEvaluatedIdea(
  supabase: SupabaseClient,
  userId: string,
  integrationId: string,
  idea: GeneratedIdea,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const { data: integ } = await supabase
    .from("integrations")
    .select("provider")
    .eq("user_id", userId)
    .eq("id", integrationId)
    .maybeSingle();
  if (!integ) return { ok: false, error: "Integration not found." };

  const expiresAt = computeExpiresAt({
    kind: idea.kind as VideoIdeaKind,
    title: idea.title,
    hard_date: idea.hard_date ?? undefined,
  });

  const { data, error } = await supabase
    .from("video_ideas")
    .insert({
      user_id: userId,
      integration_id: integrationId,
      provider: (integ as { provider: string }).provider,
      title: idea.title,
      kind: idea.kind,
      hook: idea.hook ?? null,
      format: idea.format ?? null,
      rationale: idea.rationale ?? null,
      source_refs: idea.source_refs ?? {},
      expires_at: expiresAt.toISOString(),
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
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}
