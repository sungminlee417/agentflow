import { NextResponse, type NextRequest } from "next/server";
import { generateText } from "ai";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { decrypt, getModel, isProvider } from "@agentflow/core";

// Inline AI co-editor for a single field on a video idea.
//
// Body: { field: "title" | "hook" | "script" | …, style?: "shorter" | "punchier" | "alt_take", current?: string }
//
// Returns: { alternatives: [{ label, value }] } — 3 alternatives the
// user can pick from. The UI swaps the chosen one in via the existing
// PATCH route, which logs the change to video_idea_edits (so polish
// acceptance also feeds the learning loop).
//
// We DON'T touch the DB here — just call the model with the per-idea
// + per-account context and return alternatives. Cheap, idempotent,
// safe to retry.

export const maxDuration = 30;

const POLISHABLE_FIELDS = new Set([
  "title",
  "hook",
  "script",
  "post_title",
  "description",
  "cta",
  "visual_notes",
  "thumbnail_concept",
  "engagement_hook",
  "tiktok_caption",
  "youtube_title",
  "youtube_description",
  "instagram_caption",
]);

const FIELD_GUIDANCE: Record<string, string> = {
  title:
    "A specific, recordable title (≤80 chars). Avoid clickbait verbs; lead with the topic + format.",
  hook:
    "The literal first 1-3s line. Stop the scroll. Conversational, concrete, no buildup.",
  script:
    "Full beat-by-beat script with [timestamp] HOOK / BEAT 1 / BEAT 2 / CTA, each with 📢 SAY / 🎬 ACTION / 📺 ON-SCREEN TEXT / 🎵 AUDIO cues. HOOK ≤3s, total ≤60s for short-form.",
  post_title: "Punchy headline ≤100 chars. Attention-grabbing.",
  description:
    "2-3 short paragraphs ending with the CTA. No inline hashtags.",
  cta: "ONE explicit ask. Either a question that demands a comment or a specific action.",
  visual_notes:
    "4-6 bullets covering lighting / framing / props / B-roll / colour grade.",
  thumbnail_concept: "ONE visual sentence. The image, not a description of the image.",
  engagement_hook:
    "A SPECIFIC element designed to drive comments. Distinct from the opening scroll-stopping hook.",
  tiktok_caption:
    "≤150 chars, conversational, ends with a soft question. 5-7 hashtags (no leading #) provided separately in the platform pack.",
  youtube_title:
    "≤100 chars, keyword-front-loaded for search. Don't lead with a hashtag.",
  youtube_description:
    "3-5 paragraphs. First paragraph repeats the spoken content for YT's search index; subsequent paragraphs can add context, links, credits.",
  instagram_caption:
    "Hook line in the first 125 chars (truncation cutoff). Storytelling style, 2-4 short paragraphs, 150-400 chars typical.",
};

const STYLE_DIRECTIVES: Record<string, string> = {
  shorter: "Compress aggressively. Cut every word that doesn't earn its place.",
  punchier:
    "Sharpen the language. Replace generic verbs with specific ones; lead with the most concrete word.",
  alt_take:
    "Reframe the angle entirely. Same topic, different lens (e.g. comparison → tutorial, or POV → behind-the-scenes).",
};

const BodySchema = z.object({
  field: z.string(),
  style: z.enum(["shorter", "punchier", "alt_take"]).optional(),
  current: z.string().optional(),
});

const OutputSchema = z.union([
  z.object({
    alternatives: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
        }),
      )
      .min(1)
      .max(5),
  }),
  z.array(
    z.object({
      label: z.string(),
      value: z.string(),
    }),
  ),
]);

function parseJson(text: string): unknown | null {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // try fenced
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  // first balanced object/array
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    const start = trimmed.indexOf(open);
    if (start < 0) continue;
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
      if (c === open) depth += 1;
      else if (c === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const bodyRaw = (await req.json().catch(() => null)) as unknown;
  const parsed = BodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body" },
      { status: 400 },
    );
  }
  const { field, style } = parsed.data;
  if (!POLISHABLE_FIELDS.has(field)) {
    return NextResponse.json(
      { error: `Field "${field}" is not polishable.` },
      { status: 400 },
    );
  }

  const { data: idea } = await supabase
    .from("video_ideas")
    .select(
      "title, hook, format, kind, rationale, script, post_title, description, hashtags, cta, visual_notes, optimal_post_window, suggested_duration, thumbnail_concept, engagement_hook, trending_sound, platforms, integration_id",
    )
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!idea) return new NextResponse("Not found", { status: 404 });

  // Pull the per-account voice anchor: top performers + recent post-
  // mortems. Cheap — we already have it loaded for the generator.
  let voiceBlock = "";
  if (idea.integration_id) {
    const { data: reviews } = await supabase
      .from("video_idea_posts")
      .select(
        "platform, performance_verdict, performance_stats, video_ideas!inner(title, format)",
      )
      .eq("user_id", user.id)
      .eq("integration_id", idea.integration_id)
      .not("performance_verdict", "is", null)
      .neq("performance_verdict", "too_early")
      .order("last_reviewed_at", { ascending: false })
      .limit(5);
    type RevRow = {
      platform: string | null;
      performance_verdict: string | null;
      performance_stats: { ratio?: number } | null;
      video_ideas:
        | { title?: string; format?: string | null }
        | Array<{ title?: string; format?: string | null }>
        | null;
    };
    const lines: string[] = [];
    for (const r of (reviews ?? []) as unknown as RevRow[]) {
      const ideaRow = Array.isArray(r.video_ideas)
        ? r.video_ideas[0]
        : r.video_ideas;
      if (!ideaRow?.title) continue;
      const ratio = r.performance_stats?.ratio;
      lines.push(
        `- "${ideaRow.title}" (${ideaRow.format ?? "?"}) → ${r.performance_verdict}${ratio != null ? ` · ${ratio.toFixed(2)}× median` : ""}`,
      );
    }
    if (lines.length > 0) {
      voiceBlock = `\n\nVOICE ANCHOR — what's worked for this creator recently:\n${lines.join("\n")}`;
    }
  }

  const fieldGuidance =
    FIELD_GUIDANCE[field.replace(/^(tiktok|youtube|instagram)_/, "")] ??
    FIELD_GUIDANCE[field] ??
    "";
  const styleDirective = style ? STYLE_DIRECTIVES[style] : "";
  const current = parsed.data.current ?? extractCurrent(idea, field);

  const system = `You are a copy editor for a content creator's video-idea draft. Produce 3 distinct alternative ${field} candidates for the idea below.

OUTPUT FORMAT — STRICT JSON ONLY. Your response must start with \`[\` and end with \`]\`. Each item: { "label": <short distinguishing tag, ≤24 chars>, "value": <the alternative text> }. No prose, no markdown.

IDEA CONTEXT:
- Title: ${idea.title}
- Format: ${idea.format ?? "?"}
- Kind: ${idea.kind}
- Hook: ${idea.hook ?? "(none)"}
- Rationale: ${idea.rationale ?? "(none)"}

FIELD: ${field}
GUIDANCE: ${fieldGuidance}
${styleDirective ? `STYLE DIRECTIVE: ${styleDirective}` : ""}
${voiceBlock}

CURRENT VALUE:
${current ?? "(empty)"}

Produce 3 alternatives. Each must be distinct in angle/wording, not three rephrasings of the same line. Match the creator's voice from the VOICE ANCHOR above. Strict JSON array only.`;

  // Use the user's configured AI provider key.
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

  try {
    const result = await generateText({
      model: getModel(aiProvider, apiKey, userModel),
      system,
      messages: [{ role: "user", content: "Produce the 3 alternatives now." }],
    });
    const json = parseJson(result.text);
    const validated = OutputSchema.safeParse(json);
    if (!validated.success) {
      console.error(
        "[polish] parse failed:",
        result.text.slice(0, 300).replace(/\s+/g, " "),
      );
      return NextResponse.json(
        { error: "AI didn't return valid JSON alternatives." },
        { status: 502 },
      );
    }
    const alternatives = Array.isArray(validated.data)
      ? validated.data
      : validated.data.alternatives;
    return NextResponse.json({ alternatives });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

function extractCurrent(idea: Record<string, unknown>, field: string): string | null {
  if (field === "tiktok_caption") {
    const p = idea.platforms as
      | { tiktok?: { caption?: string } | null }
      | null;
    return p?.tiktok?.caption ?? null;
  }
  if (field === "youtube_title") {
    const p = idea.platforms as
      | { youtube?: { title?: string } | null }
      | null;
    return p?.youtube?.title ?? null;
  }
  if (field === "youtube_description") {
    const p = idea.platforms as
      | { youtube?: { description?: string } | null }
      | null;
    return p?.youtube?.description ?? null;
  }
  if (field === "instagram_caption") {
    const p = idea.platforms as
      | { instagram?: { caption?: string } | null }
      | null;
    return p?.instagram?.caption ?? null;
  }
  const v = idea[field];
  return v == null ? null : String(v);
}
