import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { buildToolsForIntegrations, loadIntegration } from "../tools";

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

export type VideoIdeaKind = "pattern" | "trend" | "competitor" | "seasonal";

export type GeneratedIdea = {
  title: string;
  hook?: string;
  format?: string;
  rationale?: string;
  kind: VideoIdeaKind;
  source_refs?: Record<string, unknown>;
  /** Only meaningful for seasonal — a hard date the idea should ship by. */
  hard_date?: string;
  // Upload-ready content:
  /** Full beat-by-beat script ready to record. */
  script?: string;
  /** Suggested post title (TikTok caption headline, ≤100 chars). */
  post_title?: string;
  /** Full caption/description text. */
  description?: string;
  /** Suggested hashtags WITHOUT the leading #. */
  hashtags?: string[];
  /** Specific CTA line. */
  cta?: string;
  /** Notes on visuals, transitions, on-screen text, B-roll. */
  visual_notes?: string;
};

export type VideoIdeasResult = {
  ok: boolean;
  ideas?: GeneratedIdea[];
  tokens?: number;
  error?: string;
};

const IDEA_SCHEMA = z.object({
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
});

// Accept either { ideas: [...] } or a bare [...].
const IDEAS_ENVELOPE_SCHEMA = z.union([
  z.object({ ideas: z.array(IDEA_SCHEMA) }),
  z.array(IDEA_SCHEMA),
]);

function describeAvailable(connected: string[]): string {
  const lines: string[] = [];
  lines.push(
    "- TikTok (your account): tiktok_get_my_profile, tiktok_list_my_videos, tiktok_top_my_videos",
  );
  if (connected.includes("apify")) {
    lines.push(
      "- Niche/competitor (Apify): tiktok_search_hashtag, tiktok_search_keyword, tiktok_get_profile",
    );
  }
  if (connected.includes("transcription")) {
    lines.push(
      "- Transcription: tiktok_transcribe_video — use sparingly to extract the EXACT hook from a top competitor video before deriving a competitor-kind idea.",
    );
  }
  lines.push(
    "- Uploaded analytics: list_my_analytics_uploads, get_analytics_upload",
  );
  return lines.join("\n");
}

type RecentReview = {
  title: string;
  kind: string;
  format: string | null;
  verdict: string | null;
  ratio: number | null;
  takeaways: string | null;
};

function reviewsBlock(reviews: RecentReview[]): string {
  if (reviews.length === 0) return "";
  const lines: string[] = [
    "",
    "Recent post-mortems from videos the creator has actually posted (use these to AVOID repeating past misses and DOUBLE DOWN on patterns that hit):",
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

function tiktokPrompt(
  count: number,
  today: string,
  connected: string[],
  recentReviews: RecentReview[] = [],
): string {
  const hasApify = connected.includes("apify");
  const hasReviews = recentReviews.length > 0;
  return `You are a TikTok content strategist. Produce exactly ${count} fresh video ideas as a JSON object.

Today is ${today}.

Available tools:
${describeAvailable(connected)}
${reviewsBlock(recentReviews)}

Required procedure:
1. tiktok_top_my_videos (top_n 10, from_history 100) — these are the creator's lifetime best by engagement rate (likes ÷ views), pulled across their last ~100 uploads. This tells you what their audience actually rewards, not just what they posted recently.
2. tiktok_list_my_videos (max_count 20) — most recent 20 uploads. This tells you the creator's CURRENT voice / pacing / topic focus, even if recent videos haven't all popped. Match scripts to this voice.
3. Cross-reference: the patterns in the top 10 are what works for this audience; the recent 20 is how this creator currently sounds. Your ideas should hit the top-10 patterns delivered in the recent-20 voice.
4. Extract the creator's most-used hashtags from the top performers.
${hasApify ? `5. For each of the top 2-3 hashtags, tiktok_search_hashtag (limit 15). From the results: (a) note what's trending right now, (b) collect 3-5 distinct authors (NOT the user) who consistently post in this niche — these are auto-discovered competitors.
6. For 1-2 of those competitor handles, tiktok_get_profile (videos_limit 10) to surface songs/formats they covered well that the user hasn't.
7. list_my_analytics_uploads — read any CSV uploads for deeper retention/traffic-source signal.` : `5. Skip Apify-backed competitor + trend discovery (not configured). Lean harder on pattern + seasonal kinds.
6. list_my_analytics_uploads — read any CSV uploads for deeper retention/traffic-source signal.`}

Now produce exactly ${count} ideas, balanced across these kinds based on what's available:
- "pattern": extrapolated from the user's own winning format. Suggest a specific NEW song / topic / target they haven't covered that fits the pattern.
- ${hasApify ? `"competitor": cite the competitor handle in source_refs ({competitor_handle: "...", competitor_video_url: "..."}). The idea must be something they nailed that the user hasn't.` : `"competitor": skip — no competitor data available without Apify.`}
- ${hasApify ? `"trend": cite the hashtag and/or trending sound in source_refs. Trends die fast — only include if you have direct evidence from tool calls.` : `"trend": skip — no trend data available without Apify.`}
- "seasonal": calendar-anchored — a holiday, anniversary of a famous piece, a known meme day. Include hard_date (ISO 8601) for when the idea should ship by. Today is ${today}; only suggest hard_dates in the next 60 days.

Critical:
- Every idea MUST be grounded in something you actually saw in a tool result. No invented stats, no invented competitor handles, no invented trending hashtags.
- Each title must be specific and recordable — "Cover Hotel California — acoustic vs classical" not "do another comparison video".
- hook must be the actual first spoken/shown line.
- format should be short ("acoustic vs classical comparison", "solo performance with text overlay").
- rationale: 1-2 sentences citing the specific evidence ("your top 3 videos all use this format; song X has high search volume in #fingerstyle this week").${hasReviews ? `
- The post-mortems above are GROUND TRUTH from videos this creator already shipped. Steer toward formats/hooks that hit; steer away from ones that underperformed. When you reuse a winning pattern, say so in the rationale.` : ""}

Upload-ready content for EVERY idea — the creator should be able to record + post directly from the card without writing anything new:

- script: a SHOOT-READY breakdown the creator can follow shot-for-shot. Structure it as labeled time-stamped blocks, one per line, each containing EVERY relevant cue. Required block types in this order:

    [0:00-0:03] HOOK
      📢 SAY: "<the exact words to speak, in quotes>"  (or write SHOW: if it's silent text)
      🎬 ACTION: <what you're doing on camera — pick up the guitar, lean in, jump-cut from one frame to another>
      📺 ON-SCREEN TEXT: "<exact words to put on screen, in quotes>" (or "none")
      🎵 AUDIO: <music cue, original audio, ambient — be specific>

    [0:03-0:10] BEAT 1 — Setup
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      📺 ON-SCREEN TEXT: "<...>"

    [0:10-0:25] BEAT 2 — Payoff / Demo
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      📺 ON-SCREEN TEXT: "<...>"
      ✂️ CUT: <transition note — hard cut, whip pan, match cut on a specific motion>

    [0:25-0:35] BEAT 3 — Twist / Comparison
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      📺 ON-SCREEN TEXT: "<...>"

    [0:35-0:40] CTA
      📢 SAY: "<the explicit ask, word-for-word>"
      📺 ON-SCREEN TEXT: "<short version of the ask, e.g. 'COMMENT YOUR PICK 👇'>"
      🎬 ACTION: <gesture toward comments, hold a still frame, etc.>

    The creator should not have to think — every spoken line, every on-screen text overlay, every camera action is explicit. Times are guidelines (TikTok ≤60s); adjust block lengths to fit but keep the HOOK ≤3s and CTA ≤5s. Match the creator's voice and pacing from tiktok_list_my_videos / tiktok_top_my_videos — never invent a personality.

- post_title: the catchy headline that goes at the top of the caption (≤100 chars, attention-grabbing question or claim).
- description: full caption body — 2-3 short paragraphs, conversational, ending with the CTA. Do NOT include hashtags here; they go in the hashtags field.
- hashtags: 5-7 strings WITHOUT the leading '#'. Mix broad-niche (e.g. "guitar") with specific (e.g. "fingerstyle") with one or two trend tags if available from your tool calls. NEVER invent a hashtag.
- cta: one explicit ask in a single sentence ("Comment 'nylon' or 'steel' below 👇").
- visual_notes: 4-6 short bullets covering things NOT already in the script blocks — overall lighting setup, framing (close-up vs wide), props/wardrobe, B-roll inserts, color grade, anything specific to your shooting setup. Plain text, "• " prefix per bullet.

Return ONLY a JSON object {ideas: [...]} matching the schema below. No commentary, no markdown, no code fence.

JSON schema for the final response:
{
  "ideas": [
    {
      "title": string,
      "hook": string,
      "format": string,
      "rationale": string,
      "kind": "pattern" | "trend" | "competitor" | "seasonal",
      "source_refs": { ... },        // free-form object, e.g. { "competitor_handle": "@x", "hashtag": "#y", "url": "https://..." }
      "hard_date": string,           // only for seasonal, ISO 8601 date
      "script": string,              // beat-by-beat, with timestamps
      "post_title": string,
      "description": string,
      "hashtags": [string, ...],     // no leading '#'
      "cta": string,
      "visual_notes": string
    }
  ]
}

Your VERY LAST message must be this JSON and nothing else. Do not say "Here are the ideas:" or wrap in \`\`\`.`;
}

export async function runVideoIdeasAgent({
  supabase,
  userId,
  integrationId,
  count,
  onStep,
}: {
  supabase: SupabaseClient;
  userId: string;
  /** Which specific connected account this run is for. */
  integrationId: string;
  count: number;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
}): Promise<VideoIdeasResult> {
  if (count <= 0) {
    return { ok: true, ideas: [] };
  }

  const integration = await loadIntegration(supabase, userId, integrationId);
  if (!integration) {
    return { ok: false, error: "Integration not found." };
  }
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
  } catch (err) {
    return {
      ok: false,
      error: `Could not decrypt API key: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // Scope tools to THIS specific integration so the agent doesn't
  // accidentally read another account's videos.
  const { tools, connected } = await buildToolsForIntegrations(
    supabase,
    userId,
    [integration],
  );
  if (!connected.includes("tiktok")) {
    return { ok: false, error: "TikTok integration not connected." };
  }

  // Pull recent post-mortems for this account — they ground future
  // ideas in actual outcomes (what hit, what missed).
  const recentReviews: RecentReview[] = [];
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
      // Extract the bullets under "Takeaways for the next video" — that's
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
        title: row.title,
        kind: row.kind,
        format: row.format,
        verdict: row.performance_verdict,
        ratio: row.performance_stats?.ratio ?? null,
        takeaways,
      });
    }
  } catch (err) {
    console.error("[video-ideas-agent] failed to load recent reviews:", err);
  }

  const today = new Date().toISOString().slice(0, 10);
  const system = tiktokPrompt(count, today, connected, recentReviews);

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
      stopWhen: stepCountIs(25),
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

    const parsed = parseIdeas(result.text);
    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.error("[video-ideas-agent] could not parse ideas. raw:", preview);
      return {
        ok: false,
        error: `Agent did not return valid JSON ideas. Preview: ${preview}`,
        tokens: result.usage?.totalTokens ?? undefined,
      };
    }

    return {
      ok: true,
      ideas: parsed.slice(0, count) as GeneratedIdea[],
      tokens: result.usage?.totalTokens ?? undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parseIdeas(text: string): GeneratedIdea[] | null {
  // Try (in order): the whole text, fenced JSON extracted from a code
  // block, the first balanced {...} substring, the first balanced [...]
  // substring. Models sometimes prepend prose ("Here are the ideas:")
  // or wrap output in a code fence despite instructions.
  const candidates = collectJsonCandidates(text);
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      const result = IDEAS_ENVELOPE_SCHEMA.safeParse(json);
      if (!result.success) continue;
      const ideas = Array.isArray(result.data) ? result.data : result.data.ideas;
      return ideas as GeneratedIdea[];
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function collectJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  out.push(trimmed);

  // Fenced ```json ... ``` blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed)) !== null) {
    if (m[1]) out.push(m[1].trim());
  }

  // First balanced object
  const obj = extractBalanced(trimmed, "{", "}");
  if (obj) out.push(obj);
  // First balanced array
  const arr = extractBalanced(trimmed, "[", "]");
  if (arr) out.push(arr);

  return out;
}

function extractBalanced(s: string, open: string, close: string): string | null {
  const start = s.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (c === "\\") {
        escape = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
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
