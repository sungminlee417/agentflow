import "@/lib/ai-bootstrap";
import { NextResponse, type NextRequest } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, getModel, isProvider, loadIntegration } from "@agentflow/core";
import { loadAccountContext } from "@agentflow/core";

// POST /api/video-ideas/[id]/reevaluate
//
// Judges an existing video idea against everything the system has
// learned since it was generated — recent reviews (settled post-
// mortems), recent thumbs-down rejections, and recent inline edits.
// Returns one of three verdicts:
//   - keep   : idea still holds; no changes.
//   - refine : same topic but specific field rewrites to incorporate
//              learnings (returned as a content patch the UI can apply
//              via PATCH /api/video-ideas/[id]).
//   - drop   : idea contradicts recent signals; recommend dismissing.
//
// No DB writes here — the route just returns the verdict + suggested
// patch. The UI handles "Apply" (calls PATCH with the patch) or
// "Dismiss" (PATCH status='dismissed').

export const maxDuration = 30;

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

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const { data: idea } = await supabase
    .from("video_ideas")
    .select(
      "id, integration_id, title, hook, format, kind, rationale, script, post_title, description, hashtags, cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound, source_refs, platforms, saturation_warning",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!idea) return new NextResponse("Not found", { status: 404 });
  if (!idea.integration_id) {
    return NextResponse.json(
      { error: "Idea has no primary account — re-evaluation needs context." },
      { status: 400 },
    );
  }

  // Per-account context (reviews + feedback + edits + preferences) —
  // exact same primitive the unified generator uses.
  const integration = await loadIntegration(
    supabase,
    user.id,
    idea.integration_id as string,
  );
  if (!integration) {
    return NextResponse.json(
      { error: "Source account is no longer connected." },
      { status: 400 },
    );
  }
  const acct = await loadAccountContext(supabase, user.id, integration);

  // AI provider key.
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, encrypted_key, model")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1);
  if (!keys || keys.length === 0) {
    return NextResponse.json(
      { error: "No AI provider key configured." },
      { status: 400 },
    );
  }
  const { provider: aiProvider, encrypted_key, model: userModel } = keys[0]!;
  if (!isProvider(aiProvider)) {
    return NextResponse.json(
      { error: `Unknown AI provider: ${aiProvider}` },
      { status: 500 },
    );
  }
  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch (err) {
    return NextResponse.json(
      {
        error: `Could not decrypt API key: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 },
    );
  }

  // Compose context blocks. Cheap inline summarisation — we don't need
  // the full prompt scaffolding from unifiedPrompt, just enough signal
  // for the judge.
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

  const system = `You are auditing an already-generated video idea against the creator's recent signals. Decide whether to KEEP it as-is, REFINE specific fields, or DROP it entirely.

OUTPUT FORMAT — STRICT JSON ONLY. Start with \`{\` end with \`}\`. Shape:
{
  "verdict": "keep" | "refine" | "drop",
  "reasoning": <1-2 sentences naming the specific signal(s) that drove the call>,
  "refined_fields": <object with ONLY the fields you're suggesting to change; OMIT this key entirely on "keep" or "drop">
}

THE IDEA UNDER REVIEW:
- Title: ${idea.title}
- Format: ${idea.format ?? "(none)"}
- Kind: ${idea.kind}
- Hook: ${idea.hook ?? "(none)"}
- Rationale (original): ${idea.rationale ?? "(none)"}
- Script: ${(idea.script as string | null)?.slice(0, 1200) ?? "(none)"}
- CTA: ${idea.cta ?? "(none)"}
- Visual notes: ${(idea.visual_notes as string | null)?.slice(0, 400) ?? "(none)"}
- Saturation warning: ${idea.saturation_warning ?? "(none)"}

RECENT SETTLED REVIEWS — what's actually worked / failed since this idea was drafted:
${reviewLines.length > 0 ? reviewLines.join("\n") : "(no settled reviews yet)"}

RECENT THUMBS-DOWN REJECTIONS — ideas the creator explicitly killed:
${feedbackLines.length > 0 ? feedbackLines.join("\n") : "(no rejections recorded)"}

RECENT EDITS — patterns the creator consistently rewrites (match this voice):
${editLines.length > 0 ? editLines.join("\n") : "(no edits recorded)"}

PER-ACCOUNT PREFERENCES (hard constraints):
${acct.preferences ?? "(none)"}

DECISION RULES:
- KEEP: no recent signal contradicts the idea, and the idea isn't redundant with something already posted.
- REFINE: a specific signal points to a tweak (e.g. a similar format hit + this idea's hook doesn't match the winning hook style → rewrite the hook). Only include fields you're actually changing. Match the creator's edit-pattern voice when present.
- DROP: a similar format flopped, or the creator's rejected this exact angle, or a hard preference is violated.

Be honest about uncertainty. If signal is thin, default to KEEP — don't refine just to look busy.`;

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
      return NextResponse.json(
        { error: "AI didn't return valid JSON." },
        { status: 502 },
      );
    }
    return NextResponse.json({
      verdict: validated.data.verdict,
      reasoning: validated.data.reasoning,
      refined_fields:
        validated.data.verdict === "refine"
          ? validated.data.refined_fields ?? null
          : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
