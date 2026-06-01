import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { buildToolsForUser } from "../tools";
import type { SocialScriptsKind } from "../automation-types";
import { platformForSocialScripts } from "../automation-types";

// Focused agent: produces 3-5 ready-to-record scripts for the
// creator's next videos, grounded in their channel data + niche
// trends (via Apify if connected) + uploaded analytics (if any).
//
// Different from runSocialBriefAgent in that the brief is general
// analysis + ideas + recs; this one's output is concrete scripts.

const SCRIPT_GUARDRAILS = `Critical constraints:
- Match the creator's actual voice/format/tone from their existing videos. Do not invent a new personality.
- Every concept must be tied to evidence: cite which of the creator's videos or which niche/competitor trend informed it.
- Never invent stats or hashtags. If a number or a hashtag isn't in a tool result, don't include it.
- Don't pad. 3-5 scripts max. Better to ship 3 sharp ones than 5 mediocre.
- Each script must be SHORT-FORM-pacing-aware: hooks die fast. The first line of the script must be the actual spoken-or-shown hook.`;

const TIKTOK_SCRIPT_FORMAT = `Each script:
## [N]. Working title
**Hook (0-3s):** the EXACT first thing on screen + said. Must stop a scroll in <1 second.
**Beat 1 (3-10s):** establish stakes / context
**Beat 2 (10-25s):** the meat — the actual value or twist
**Beat 3 (25-40s):** payoff + transition to CTA
**CTA:** specific ask (comment with X, follow for part 2, save for later)
**Suggested hashtags:** 5-7 relevant ones, mixing broad niche + specific tags from competitor research
**Visual notes:** what to film, key transitions, b-roll, any text-on-screen at key moments
**Why this could hit:** 1-2 sentence justification tied to specific evidence from tool calls (e.g. "your video #123 about X got 3x your normal views; this builds on that hook style")`;

const YOUTUBE_SCRIPT_FORMAT = `Each script:
## [N]. Working title
**Suggested title:** clickable, <60 chars
**Thumbnail concept:** what to put on the thumbnail in 1 sentence
**Hook (0-15s):** opening that makes them not click away
**Body outline (with rough timestamps):** 4-7 beats covering the main content
**Pattern interrupts:** where to add visual changes / B-roll to maintain retention
**Outro / CTA:** specific ask
**Suggested tags & description starter:** 8-12 tags + first 2 lines of description
**Why this could hit:** 1-2 sentence justification tied to specific evidence from tool calls`;

const INSTAGRAM_SCRIPT_FORMAT = `Each post:
## [N]. Working title
**Format:** Reel / Carousel / Single image — and why this format
**Hook / first frame:** what shows up first
**For Reels:** beat-by-beat script like a TikTok
**For Carousels:** slide-by-slide outline (typically 6-10 slides; first slide is the hook)
**Caption:** full draft, 2-3 paragraphs, ending in a CTA
**Suggested hashtags:** 10-15 mixing niche / community / broad
**Why this could hit:** 1-2 sentence justification tied to evidence from tool calls`;

function tiktokPrompt(focus: string | undefined, available: string): string {
  return `You are a TikTok scriptwriter. Produce 3-5 ready-to-record scripts for the creator's next videos.

Available tools:
${available}

${focus ? `Channel focus: ${focus}\n\n` : ""}Required procedure:
1. tiktok_get_my_profile + tiktok_list_my_videos (max_count 20). Identify the creator's voice, pacing, recurring topics.
2. From their top 3 videos by engagement rate (likes ÷ views), figure out what's working.
3. list_my_analytics_uploads — if uploads exist, get_analytics_upload them. Retention curves + traffic sources tell you what kept viewers watching.
4. If Apify is in available tools: tiktok_search_hashtag and/or tiktok_search_keyword on 2-3 queries derived from the creator's niche. Find what's currently breaking out (high views relative to creator's followers).
5. Cross-reference: where do the creator's strengths + niche trends overlap? Those are your concept seeds.
6. Write 3-5 scripts using this format:

${TIKTOK_SCRIPT_FORMAT}

${SCRIPT_GUARDRAILS}`;
}

function youtubePrompt(focus: string | undefined, available: string): string {
  return `You are a YouTube scriptwriter. Produce 3-5 ready-to-record scripts for the creator's next videos.

Available tools:
${available}

${focus ? `Channel focus: ${focus}\n\n` : ""}Required procedure:
1. youtube_get_my_channel + youtube_list_my_videos (limit 25). Identify the creator's voice, format, recurring topics.
2. For the top 3 videos by views, call youtube_get_video_analytics + youtube_get_video_traffic_sources. Pay attention to CTR, AVD, retention shape, traffic source dominance.
3. list_my_analytics_uploads — if uploads exist, get_analytics_upload for any historical context the API didn't surface.
4. youtube_search_niche on 2-3 queries derived from the creator's topics or the focus. Note what's working: title patterns, thumbnail style hints (from titles), publish timing.
5. Cross-reference: high-performing niche topics × creator's existing audience interest. Those are concept seeds.
6. Write 3-5 scripts using this format:

${YOUTUBE_SCRIPT_FORMAT}

${SCRIPT_GUARDRAILS}`;
}

function instagramPrompt(focus: string | undefined, available: string): string {
  return `You are an Instagram scriptwriter. Produce 3-5 ready-to-publish post concepts for the creator.

Available tools:
${available}

${focus ? `Channel focus: ${focus}\n\n` : ""}Required procedure:
1. instagram_get_my_account + instagram_list_my_media (limit 20). Identify the creator's mix (Reels vs Carousels vs single), voice, recurring topics.
2. For top 3 posts by like-to-reach ratio, call instagram_get_media_insights. Look at saves and shares — those signal genuinely shareable content.
3. instagram_list_comments on top posts. Audience questions and themes are gold for content seeds.
4. list_my_analytics_uploads — read any uploaded Meta Business Suite exports for deeper historical signal.
5. Decide which format mix to recommend (mostly Reels for reach? Carousels for saves? Singles for top-of-funnel?). Then write the posts.

${INSTAGRAM_SCRIPT_FORMAT}

${SCRIPT_GUARDRAILS}`;
}

function describeAvailableTools(connected: string[]): string {
  const lines: string[] = [];
  if (connected.includes("youtube")) {
    lines.push(
      "- YouTube: youtube_get_my_channel, youtube_list_my_videos, youtube_get_video_analytics, youtube_get_video_traffic_sources, youtube_search_niche, youtube_get_video_comments",
    );
  }
  if (connected.includes("tiktok")) {
    lines.push(
      "- TikTok: tiktok_get_my_profile, tiktok_list_my_videos, tiktok_query_videos",
    );
  }
  if (connected.includes("instagram")) {
    lines.push(
      "- Instagram: instagram_get_my_account, instagram_list_my_media, instagram_get_media_insights, instagram_get_account_insights, instagram_list_comments",
    );
  }
  if (connected.includes("apify")) {
    lines.push(
      "- Apify-backed niche/competitor: tiktok_search_hashtag, tiktok_search_keyword, tiktok_get_profile",
    );
  }
  lines.push(
    "- Uploaded analytics: list_my_analytics_uploads, get_analytics_upload — read these for retention curves, traffic sources, demographics not available in any API.",
  );
  return lines.join("\n");
}

export type SocialScriptsResult = {
  ok: boolean;
  report_markdown?: string;
  tokens?: number;
  error?: string;
};

export async function runSocialScriptsAgent({
  supabase,
  userId,
  type,
  focus,
  onStep,
}: {
  supabase: SupabaseClient;
  userId: string;
  type: SocialScriptsKind;
  focus?: string;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
}): Promise<SocialScriptsResult> {
  const { data: keys } = await supabase
    .from("user_api_keys")
    .select("provider, encrypted_key, model")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (!keys || keys.length === 0) {
    return { ok: false, error: "No AI provider key configured." };
  }
  const { provider, encrypted_key, model: userModel } = keys[0]!;
  if (!isProvider(provider)) {
    return { ok: false, error: `Unknown provider: ${provider}` };
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

  const { tools, connected } = await buildToolsForUser(supabase, userId);
  const platform = platformForSocialScripts(type);
  if (!connected.includes(platform)) {
    return { ok: false, error: `${platform} integration not connected.` };
  }

  const available = describeAvailableTools(connected);
  const system =
    platform === "youtube"
      ? youtubePrompt(focus, available)
      : platform === "tiktok"
        ? tiktokPrompt(focus, available)
        : instagramPrompt(focus, available);

  let stepCount = 0;
  try {
    const result = await generateText({
      model: getModel(provider, apiKey, userModel),
      system,
      providerOptions:
        provider === "anthropic"
          ? { anthropic: { cacheControl: { type: "ephemeral" } } }
          : undefined,
      messages: [
        {
          role: "user",
          content: `Produce 3-5 ready-to-record scripts for my next ${platform} videos.`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      stopWhen: stepCountIs(30),
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

    return {
      ok: true,
      report_markdown: result.text,
      tokens: result.usage?.totalTokens ?? undefined,
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
  if (toolCalls.length === 0) return "Drafting scripts";
  const last = toolCalls[toolCalls.length - 1];
  return `Calling ${String(last?.toolName ?? "tool")}`;
}
