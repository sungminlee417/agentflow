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

// Soft schema for "graceful degradation": when the strict schema fails
// (e.g. model added an unexpected field or skipped a required one in
// the nested idea), we fall back to extracting just verdict + reasoning.
// That's enough to tell the user "needs work / pass" with the model's
// explanation, even if we can't auto-insert.
const EVALUATION_SOFT_SCHEMA = z
  .object({
    verdict: z.enum(["add", "needs_work", "pass"]),
    reasoning: z.string().min(1),
  })
  .passthrough();

const EVALUATION_SCHEMA = z
  .object({
    verdict: z.enum(["add", "needs_work", "pass"]),
    reasoning: z.string(),
    idea: z
      .object({
        title: z.string(),
        hook: z.string().nullish(),
        format: z.string().nullish(),
        rationale: z.string().nullish(),
        // Be permissive on `kind` — the model occasionally invents
        // adjacent labels (e.g. "rising_trend" instead of "rising").
        // We normalize after parse.
        kind: z.string(),
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
        saturation_warning: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const VALID_KINDS = new Set<GeneratedIdea["kind"]>([
  "pattern",
  "trend",
  "rising",
  "competitor",
  "seasonal",
]);

function normalizeKind(raw: string): GeneratedIdea["kind"] {
  const k = raw.toLowerCase().trim();
  if (VALID_KINDS.has(k as GeneratedIdea["kind"]))
    return k as GeneratedIdea["kind"];
  // Common LLM variations → canonical.
  if (k.startsWith("rising") || k.includes("velocity")) return "rising";
  if (k.startsWith("trend")) return "trend";
  if (k.startsWith("competitor") || k.startsWith("peer")) return "competitor";
  if (k.startsWith("season") || k.startsWith("calendar")) return "seasonal";
  return "pattern";
}

type EvalReview = {
  title: string;
  kind: string;
  format: string | null;
  verdict: string | null;
  ratio: number | null;
  takeaways: string | null;
};

function reviewsBlockForEvaluator(reviews: EvalReview[]): string {
  if (reviews.length === 0) return "";
  const lines: string[] = [
    "",
    "PRIOR POST-MORTEMS — ground truth from videos this creator already shipped. Use these to judge whether the spark fits or repeats a past miss:",
  ];
  for (const r of reviews) {
    const ratioStr = r.ratio != null ? `${r.ratio.toFixed(2)}× median` : "unrated";
    lines.push(
      `- "${r.title}" (${r.kind}, ${r.format ?? "?"}): ${r.verdict ?? "?"} · ${ratioStr}`,
    );
    if (r.takeaways) {
      lines.push(`  Learnings: ${r.takeaways}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(args: {
  rawIdea: string;
  today: string;
  hasApify: boolean;
  preferences: string | null;
  reviews: EvalReview[];
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
"${args.rawIdea}"${prefBlock}${reviewsBlockForEvaluator(args.reviews)}

Required procedure:
1. tiktok_top_my_videos (top_n 10, from_history 100) — what hits for this creator.
2. tiktok_list_my_videos (max_count 20) — current voice.
3. ${args.hasApify ? `tiktok_search_hashtag on the creator's primary niche hashtag (limit 20) to see what's working in the space right now.
   • Velocity check: group results by week using create_time. If the past 3-7 days' top videos have notably higher engagement than the prior week, the format/topic is RISING — consider labeling kind="rising" with a velocity_note in source_refs.
   • Saturation check: if 15+ recent videos in the niche use the same format as the spark with below-niche-median engagement, the topic is saturated — note this and either reframe (needs_work) or pass.` : "(Apify not configured — judge from the creator's own data only; you cannot label something 'rising' without velocity evidence.)"}
4. Compare the spark against what works for this creator's audience. Be SPECIFIC about why it does or doesn't fit.

Verdict rules:
- "add" → it clearly fits the creator's winning pattern, you have a concrete plan, and you're confident it would perform on par with or above their median. Fully flesh out the idea (every upload-ready field, every virality field).
- "needs_work" → the spark has potential but needs reframing to fit. Provide a SPECIFIC reframing in reasoning, and partially fill the idea (title + format + rationale + a couple of fields). Skip script/full content — the user should iterate before you commit to those.
- "pass" → it's off-niche, contradicts what works for this creator, OR the format is saturated with poor returns. State the specific reason ("your top 10 are all comparison hooks; solo performance of an obscure piece would underperform your median by 40-60%", "#fingerstyle currently has 30+ posts in this exact format with engagement dropping ~40% vs niche median", or "your last underperformed video was the same solo-performance format — see the post-mortem"). Do NOT include the idea object in the response.

If any prior post-mortem above is RELEVANT to the spark — same format, same hook style, similar topic — your reasoning MUST cite it by title (e.g. 'Your "Bach Prelude solo" hit 0.43× median — same solo-performance format. Reframe to comparison or pass.'). The post-mortems are ground truth; ignoring them when they apply is the worst kind of judgment.

Return EXACTLY this JSON object and nothing else:
{
  "verdict": "add" | "needs_work" | "pass",
  "reasoning": string,  // 2-3 sentences max, grounded in actual tool data
  "idea": { ... } | null  // present for "add" (fully fleshed) or "needs_work" (partial); null for "pass"
}

If verdict is "add", the idea object must include EVERY field that the bulk video-ideas-agent produces: title, hook, format, rationale, kind, source_refs, script (shot-by-shot with SAY/ACTION/ON-SCREEN TEXT cues), post_title, description, hashtags (no leading #), cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound (or null). Match the creator's voice from their actual videos. Never invent stats or hashtags.

Return ONLY the JSON. No preamble, no code fence.

The "kind" field must be one of: "pattern", "trend", "rising", "competitor", "seasonal". Do not invent adjacent labels like "rising_trend" or "competitor_format" — pick the closest one. If the spark fits a pattern the creator has already won with, that's "pattern".

If you're going to set verdict="add", be CERTAIN every required idea field is present and well-formed. If you're not sure you can produce a full upload-ready idea (with shoot-by-shoot script, all five virality fields, etc.), prefer "needs_work" with a clear reframing reason — the user can iterate from there. Half-baked "add" objects waste the user's credits.

Your VERY LAST output must be the JSON object. Nothing after it.`;
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
    let json: unknown;
    try {
      json = JSON.parse(c);
    } catch {
      continue;
    }
    // First try the strict schema.
    const strict = EVALUATION_SCHEMA.safeParse(json);
    if (strict.success) {
      const idea = strict.data.idea
        ? {
            ...strict.data.idea,
            kind: normalizeKind(strict.data.idea.kind),
          }
        : undefined;
      return {
        ok: true,
        verdict: strict.data.verdict,
        reasoning: strict.data.reasoning,
        idea: idea as GeneratedIdea | undefined,
      };
    }
    // Soft fallback: the model gave us a valid verdict + reasoning but
    // bungled the idea sub-object (or some other passthrough field).
    // Return the verdict so the user sees the explanation, drop the
    // half-baked idea body.
    const soft = EVALUATION_SOFT_SCHEMA.safeParse(json);
    if (soft.success) {
      return {
        ok: true,
        verdict: soft.data.verdict,
        reasoning: soft.data.reasoning,
        // Even for "add" verdicts we drop the idea here — the strict
        // schema's failure means we don't trust the idea body enough
        // to insert. The user gets the reasoning + can iterate.
        idea: undefined,
      };
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

  // Prior post-mortems — same wiring as the bulk generator so the
  // evaluator can compare a user spark against actual ground truth.
  const reviews: EvalReview[] = [];
  try {
    const { data: reviewed } = await supabase
      .from("video_ideas")
      .select(
        "title, kind, format, performance_verdict, performance_stats, performance_review",
      )
      .eq("user_id", userId)
      .eq("integration_id", integrationId)
      .not("performance_verdict", "is", null)
      .order("last_reviewed_at", { ascending: false })
      .limit(8);
    for (const row of (reviewed ?? []) as Array<{
      title: string;
      kind: string;
      format: string | null;
      performance_verdict: string | null;
      performance_stats: { ratio?: number } | null;
      performance_review: string | null;
    }>) {
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
      reviews.push({
        title: row.title,
        kind: row.kind,
        format: row.format,
        verdict: row.performance_verdict,
        ratio: row.performance_stats?.ratio ?? null,
        takeaways,
      });
    }
  } catch (err) {
    console.error("[evaluate-idea-agent] failed to load reviews:", err);
  }

  const today = new Date().toISOString().slice(0, 10);
  const system = buildPrompt({
    rawIdea: trimmed,
    today,
    hasApify: connected.includes("apify"),
    preferences,
    reviews,
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
      const preview = result.text.slice(0, 600).replace(/\s+/g, " ").trim();
      console.error(
        "[evaluate-idea-agent] could not parse evaluation. raw:",
        preview,
      );
      return {
        ok: false,
        error: `Agent didn't return a valid evaluation. The model said: ${preview.slice(0, 240)}${preview.length > 240 ? "…" : ""}`,
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
      saturation_warning: idea.saturation_warning ?? null,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, id: (data as { id: string }).id };
}
