import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText, stepCountIs } from "ai";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { buildToolsForUser } from "../tools";
import type { SocialBriefKind } from "../automation-types";
import { platformForSocialBrief } from "../automation-types";

// Autonomous social media brief agent. Reads whichever data sources
// the user has connected for the target platform(s) and produces a
// concrete, actionable markdown brief: what's working, what's
// trending, what to make next, with example titles/hooks/scripts.

const SHARED_GUARDRAILS = `Constraints:
- Be specific and grounded in real data. Never invent stats, video titles, or hashtags. If you cite a number, it must come from a tool call.
- Reference exact video titles, IDs, and metrics from tool calls.
- Don't ramble. Tight prose, scannable structure.
- Output markdown. Lead with the actionable list; put deeper analysis below.
- Always end with a "Next 3 things to do" section as a numbered list of explicit actions the creator should take this week.`;

function describeAvailableTools(connected: string[]): string {
  const tools: string[] = [];
  if (connected.includes("youtube")) {
    tools.push(
      "YouTube: youtube_get_my_channel, youtube_list_my_videos, youtube_get_video_analytics (CTR/AVD/retention), youtube_get_video_traffic_sources, youtube_search_niche, youtube_get_video_comments",
    );
  }
  if (connected.includes("tiktok")) {
    tools.push(
      "TikTok: tiktok_get_my_profile, tiktok_list_my_videos, tiktok_query_videos",
    );
  }
  if (connected.includes("instagram")) {
    tools.push(
      "Instagram: instagram_get_my_account, instagram_list_my_media, instagram_get_media_insights, instagram_get_account_insights, instagram_list_comments",
    );
  }
  if (connected.includes("apify")) {
    tools.push(
      "Apify-backed niche/competitor: tiktok_search_hashtag, tiktok_search_keyword, tiktok_get_profile",
    );
  }
  if (connected.includes("transcription")) {
    tools.push(
      "Video transcription: tiktok_transcribe_video — pull the actual spoken script of any TikTok video. Best used on top performers to extract their exact hook + pacing patterns.",
    );
  }
  tools.push(
    "Uploaded analytics: list_my_analytics_uploads + get_analytics_upload — call these FIRST when discussing retention, traffic sources, or audience demographics, since these are not in any platform API.",
  );
  return tools.map((t) => `- ${t}`).join("\n");
}

function youtubePrompt(focus: string | undefined, available: string): string {
  return `You are a YouTube growth strategist for the creator who hired you. Produce a weekly content brief.

Available tools:
${available}

${focus ? `Niche focus the creator cares about: ${focus}\n\n` : ""}Procedure:
1. youtube_get_my_channel → anchor.
2. youtube_list_my_videos (limit 25) → recent performance baseline.
3. Pick the 3 highest-engagement videos by views; for each: youtube_get_video_analytics + youtube_get_video_traffic_sources. Look at CTR, AVD, retention, traffic source dominance.
4. list_my_analytics_uploads — if uploads exist, get_analytics_upload to surface what the API misses.
5. youtube_search_niche on 2-3 queries derived from the creator's actual top topics OR the focus passed in — find what's getting traction lately.
6. Produce the brief.

Output structure (markdown):
- ## What worked this week (3-5 bullets with concrete video refs and metrics)
- ## What's trending in your niche (top 5 themes with example titles + view counts from search)
- ## 5 new video concepts (each: working title, hook, why it'll work, similarity to your top performer)
- ## Suggested title rewrites for your lowest-CTR recent video (give 5 alternatives)
- ## Next 3 things to do (numbered list, explicit)

${SHARED_GUARDRAILS}`;
}

function tiktokPrompt(focus: string | undefined, available: string): string {
  return `You are a TikTok growth strategist for the creator who hired you. Produce a weekly content brief.

Available tools:
${available}

${focus ? `Niche focus the creator cares about: ${focus}\n\n` : ""}Procedure:
1. tiktok_get_my_profile → anchor.
2. tiktok_list_my_videos (max_count 20) → recent performance baseline.
3. list_my_analytics_uploads — if the creator uploaded TikTok Studio exports, get_analytics_upload them. Retention curves + traffic sources from Studio are the highest-value signal — read them carefully.
4. If Apify is in available tools: tiktok_search_hashtag or tiktok_search_keyword on 2-3 niche-relevant queries (or the focus passed in). Pull what's currently winning.
5. Identify patterns in YOUR top 3 videos by likes/view ratio (engagement rate) — what do captions, hashtags, music have in common?

Output structure (markdown):
- ## What worked this week (3-5 bullets with concrete video refs and stats)
- ## Engagement-rate patterns in your top videos (caption length, hashtag families, music, hook style)
- ${available.includes("Apify") ? "## What's hot in your niche right now (5 trending examples with caption + view count + why they hit)\n- " : ""}## 5 new video concepts (each: working title, hook line, target hashtags, why)
- ## Hook rewrites for your lowest-performing recent video (5 first-2-second openers to A/B)
- ## Next 3 things to do (numbered list, explicit)

${SHARED_GUARDRAILS}`;
}

function instagramPrompt(focus: string | undefined, available: string): string {
  return `You are an Instagram growth strategist for the creator who hired you. Produce a weekly content brief.

Available tools:
${available}

${focus ? `Niche focus the creator cares about: ${focus}\n\n` : ""}Procedure:
1. instagram_get_my_account → anchor.
2. instagram_get_account_insights (days: 30) → reach, profile views, follower trend.
3. instagram_list_my_media (limit 20) → recent posts.
4. Pick 3 with the best like-to-reach ratio; for each: instagram_get_media_insights + instagram_list_comments. Look at saves and shares — those signal genuinely viral content.
5. list_my_analytics_uploads — read any uploaded Meta Business Suite exports for deeper history.
6. Read the comments on top posts — what questions/sentiments come up? Use those to seed content ideas.

Output structure (markdown):
- ## What worked this week (3-5 bullets with concrete post refs and metrics)
- ## Audience signals from comments (sentiment, FAQs, recurring asks)
- ## 5 new post concepts (each: format — Reel / Carousel / Single — caption direction, why it fits)
- ## Carousel idea: 8-slide outline for your top-performing topic
- ## Next 3 things to do (numbered list, explicit)

${SHARED_GUARDRAILS}`;
}

function crossPlatformPrompt(focus: string | undefined, available: string): string {
  return `You are a cross-platform social media growth strategist for the creator who hired you. They want a brief that looks across whichever platforms they've connected.

Available tools:
${available}

${focus ? `Niche focus the creator cares about: ${focus}\n\n` : ""}Procedure:
1. For each connected platform (YouTube / TikTok / Instagram), pull the most recent 10-15 pieces of content with their key engagement metrics.
2. list_my_analytics_uploads — read any uploaded exports for deeper retention / traffic / demographic data.
3. Compare across platforms: which platform is the user growing fastest on? Which has the highest engagement rate? Is there content that crossed over well?
4. If Apify is available: pull niche-relevant trending content on TikTok.

Output structure (markdown):
- ## Platform-by-platform snapshot (table with growth rate, engagement rate, top piece this period)
- ## What crossed over (themes that worked on more than one platform — these are your highest-leverage topics)
- ## Where to concentrate effort (1-2 platforms — explain why)
- ## 5 content concepts that could work on multiple platforms (with platform-specific framing for each)
- ## Next 3 things to do (numbered list, explicit)

${SHARED_GUARDRAILS}`;
}

export type SocialBriefResult = {
  ok: boolean;
  report_markdown?: string;
  tokens?: number;
  error?: string;
};

export async function runSocialBriefAgent({
  supabase,
  userId,
  type,
  focus,
  onStep,
}: {
  supabase: SupabaseClient;
  userId: string;
  type: SocialBriefKind;
  focus?: string;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
}): Promise<SocialBriefResult> {
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
  const platform = platformForSocialBrief(type);
  if (platform !== "cross" && !connected.includes(platform)) {
    return {
      ok: false,
      error: `${platform} integration not connected.`,
    };
  }

  const available = describeAvailableTools(connected);
  const system =
    platform === "youtube"
      ? youtubePrompt(focus, available)
      : platform === "tiktok"
        ? tiktokPrompt(focus, available)
        : platform === "instagram"
          ? instagramPrompt(focus, available)
          : crossPlatformPrompt(focus, available);

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
          content: `Produce the brief for ${platform === "cross" ? "all my connected platforms" : platform}.`,
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: tools as any,
      stopWhen: stepCountIs(25),
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
  if (toolCalls.length === 0) return "Drafting brief";
  const last = toolCalls[toolCalls.length - 1];
  const name = String(last?.toolName ?? "tool");
  return `Calling ${name}`;
}
