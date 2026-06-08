import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { z } from "zod";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { loadIntegration } from "../tools";
import { loadAccountContext } from "./video-ideas/context";

// Shared core for the re-evaluate flow. Used by:
//   • POST /api/video-ideas/[id]/reevaluate (UI button on the detail
//     modal — returns verdict + reasoning + refined_fields)
//   • The chat agent's video_ideas_reevaluate tool (same shape; the
//     agent then decides whether to chain video_ideas_update with the
//     refined fields, video_ideas_set_status('dismissed') on drop, etc).
//
// The decision-grade prompt is the same in both surfaces — preferences
// are treated as hard constraints, every field that violates one must
// be rewritten, drop is reserved for topics that can't survive a
// constraint rewrite.

const REFINED_FIELDS_SCHEMA = z
  .object({
    title: z.string().nullish(),
    hook: z.string().nullish(),
    rationale: z.string().nullish(),
    script: z.string().nullish(),
    post_title: z.string().nullish(),
    description: z.string().nullish(),
    cta: z.string().nullish(),
    visual_notes: z.string().nullish(),
    optimal_post_window: z.string().nullish(),
    suggested_duration: z.string().nullish(),
    thumbnail_concept: z.string().nullish(),
    engagement_hook: z.string().nullish(),
  })
  .partial();

const OUTPUT_SCHEMA = z.object({
  verdict: z.enum(["keep", "refine", "drop"]),
  reasoning: z.string(),
  refined_fields: REFINED_FIELDS_SCHEMA.nullish(),
});

export type ReevaluateResult =
  | {
      ok: true;
      verdict: "keep" | "refine" | "drop";
      reasoning: string;
      refined_fields: Record<string, string> | null;
    }
  | { ok: false; error: string };

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* try fenced */
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      /* fall through */
    }
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function reevaluateIdea({
  supabase,
  userId,
  ideaId,
}: {
  supabase: SupabaseClient;
  userId: string;
  ideaId: string;
}): Promise<ReevaluateResult> {
  const { data: idea } = await supabase
    .from("video_ideas")
    .select(
      "id, integration_id, title, hook, format, kind, rationale, script, post_title, description, hashtags, cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound, source_refs, platforms, saturation_warning",
    )
    .eq("id", ideaId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!idea) return { ok: false, error: "Idea not found." };
  if (!idea.integration_id) {
    return {
      ok: false,
      error: "Idea has no primary account — re-evaluation needs context.",
    };
  }

  const integration = await loadIntegration(
    supabase,
    userId,
    idea.integration_id as string,
  );
  if (!integration) {
    return { ok: false, error: "Source account is no longer connected." };
  }
  const acct = await loadAccountContext(supabase, userId, integration);

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

  const reviewLines = acct.recentReviews.map(
    (r) =>
      `- "${r.title}" (${r.kind}, ${r.format ?? "?"}, ${r.platform ?? "?"}): ${r.verdict ?? "?"}${r.ratio != null ? ` · ${r.ratio.toFixed(2)}× median` : ""}${r.takeaways ? ` — ${r.takeaways}` : ""}`,
  );
  const feedbackLines = acct.recentFeedback.map(
    (f) =>
      `- "${f.title}" (${f.kind}, ${f.format ?? "?"}): ${f.reason_code}${f.hook ? ` · hook: "${f.hook}"` : ""}${f.free_text ? ` · creator note: ${f.free_text}` : ""}`,
  );
  const editLines = (acct.recentEdits ?? []).map(
    (e) =>
      `- ${e.field}: agent wrote "${(e.original_value ?? "").slice(0, 120)}" → creator rewrote to "${(e.edited_value ?? "").slice(0, 120)}"`,
  );

  const hasPrefs = !!acct.preferences && acct.preferences.trim().length > 0;
  const system = `You are auditing a draft video idea against the creator's signals. Decide KEEP, REFINE, or DROP.

═══════════════════════════════════════════════
NON-NEGOTIABLE CREATOR CONSTRAINTS — read FIRST, enforce ABSOLUTELY
═══════════════════════════════════════════════
${hasPrefs ? acct.preferences : "(none set for this account)"}

These constraints are HARD LIMITS, not preferences. They override every other signal in this prompt.

ENFORCEMENT PROCEDURE:
  1. Read the constraints above.
  2. Read the script, hook, CTA, visual notes, and thumbnail concept.
  3. For each constraint, check whether ANY line in the draft (spoken, on-screen, action cue, location, prop, etc.) violates it. Examples of violation:
       - constraint: "don't film in gym" → ANY mention of gym, weights, squat rack, treadmill, "in the gym", or visual cues showing gym = VIOLATION
       - constraint: "no face on camera" → any "point at camera", "look at lens", face-shot framing = VIOLATION
       - constraint: "indoor only" → any "outside", "park", "street" = VIOLATION
  4. If ANY violation exists, you MUST do one of:
       (a) REFINE: rewrite EVERY violating field to remove the violation. The refined script/hook/visual notes must contain ZERO references to the forbidden subject. Replace forbidden locations/props with constraint-compatible alternatives (e.g. gym → home setup, weights → resistance band at desk).
       (b) DROP: if the topic genuinely can't work without violating the constraint (e.g. "best gym machine for chest" inherently requires a gym), drop it.
   You may NEVER return KEEP when a violation exists.
  5. If no violations exist, evaluate against the other signals below.

═══════════════════════════════════════════════
OUTPUT FORMAT — STRICT JSON ONLY
═══════════════════════════════════════════════
Start with \`{\` end with \`}\`. Shape:
{
  "verdict": "keep" | "refine" | "drop",
  "reasoning": <1-2 sentences naming the specific signal(s) that drove the call. If a constraint was violated, say so explicitly.>,
  "refined_fields": <object with ONLY the fields you're rewriting; OMIT this key entirely on "keep" or "drop">
}

When refining, common fields to rewrite together when removing a constraint violation:
- script (the beat-by-beat — replace location/action/on-screen text cues that reference the forbidden subject)
- hook (the opening line if it mentions the forbidden subject)
- visual_notes (the shot list — strip any forbidden props/locations)
- thumbnail_concept (replace if it depicts the forbidden subject)
- rationale (update to reflect the new angle)

═══════════════════════════════════════════════
THE IDEA UNDER REVIEW
═══════════════════════════════════════════════
- Title: ${idea.title}
- Format: ${idea.format ?? "(none)"}
- Kind: ${idea.kind}
- Hook: ${idea.hook ?? "(none)"}
- Rationale (original): ${idea.rationale ?? "(none)"}
- Script: ${(idea.script as string | null)?.slice(0, 1500) ?? "(none)"}
- CTA: ${idea.cta ?? "(none)"}
- Visual notes: ${(idea.visual_notes as string | null)?.slice(0, 500) ?? "(none)"}
- Thumbnail concept: ${idea.thumbnail_concept ?? "(none)"}
- Saturation warning: ${idea.saturation_warning ?? "(none)"}

═══════════════════════════════════════════════
OTHER SIGNALS (only consult after constraint check passes)
═══════════════════════════════════════════════

RECENT SETTLED REVIEWS — what's actually worked / failed since this idea was drafted:
${reviewLines.length > 0 ? reviewLines.join("\n") : "(no settled reviews yet)"}

RECENT THUMBS-DOWN REJECTIONS — ideas the creator explicitly killed:
${feedbackLines.length > 0 ? feedbackLines.join("\n") : "(no rejections recorded)"}

RECENT EDITS — patterns the creator consistently rewrites (match this voice):
${editLines.length > 0 ? editLines.join("\n") : "(no edits recorded)"}

═══════════════════════════════════════════════
DECISION RULES (after constraint check)
═══════════════════════════════════════════════
- KEEP: no constraint violation AND no recent signal contradicts the idea AND the idea isn't redundant with something already posted.
- REFINE: a specific signal points to a tweak. Only include fields you're actually changing. Match the creator's edit-pattern voice when present.
- DROP: a similar format flopped, the creator rejected this exact angle, OR the topic inherently requires violating a constraint.

Be honest about uncertainty. If signal is thin AND no constraint violation, default to KEEP.`;

  try {
    const result = await generateText({
      model: getModel(aiProvider, apiKey, userModel),
      system,
      messages: [
        {
          role: "user",
          content: "Audit this idea now and return your verdict.",
        },
      ],
    });
    const json = parseJson(result.text);
    const validated = OUTPUT_SCHEMA.safeParse(json);
    if (!validated.success) {
      console.error(
        "[reevaluate] parse failed:",
        result.text.slice(0, 300).replace(/\s+/g, " "),
      );
      return { ok: false, error: "AI didn't return valid JSON." };
    }
    return {
      ok: true,
      verdict: validated.data.verdict,
      reasoning: validated.data.reasoning,
      refined_fields:
        validated.data.verdict === "refine"
          ? (validated.data.refined_fields as Record<string, string>) ?? null
          : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
