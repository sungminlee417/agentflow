import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { getFreshAccessToken } from "../oauth-refresh";
import { extractPostedVideoId } from "./video-review/url-parsers";
import {
  TT_FIELDS,
  tt,
  fetchInstagramBaselineRates,
  fetchInstagramMediaIdByShortcode,
  fetchInstagramStats,
  fetchTikTokBaselineRates,
  fetchTikTokStats,
  fetchYouTubeBaselineRates,
  fetchYouTubeStats,
  type PlatformStats,
  type TikTokVideo,
} from "./video-review/platform-stats";

// Closed-loop performance review.
//
// Given an idea the user marked 'done' + the TikTok video they posted,
// pull the actual stats, compare to their baseline, classify the
// outcome, and write a post-mortem.
//
// Cadence (set by the caller via next_review_at):
//   • First review at +48h from posted_at — viral velocity has played
//     out, audience signal is meaningful.
//   • Second review at +7d — most growth has plateaued, this is the
//     "settled" reading; verdict at this point is final and feeds
//     forward into future idea generation.
//
// All four output fields land on the idea row: verdict (categorical),
// score (engagement rate), review (markdown prose), stats (JSON
// snapshot for the UI).

export type ReviewVerdict =
  | "hit"
  | "on_track"
  | "underperformed"
  | "too_early";

export type ReviewResult = {
  ok: boolean;
  verdict?: ReviewVerdict;
  score?: number;
  review?: string;
  stats?: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    engagement_rate: number;
    baseline_median_rate: number;
    ratio: number;
    hours_since_posted: number;
  };
  next_review_at?: Date | null;
  error?: string;
};

function pickVerdict(ratio: number, hoursSincePosted: number): ReviewVerdict {
  if (hoursSincePosted < 24) return "too_early";
  if (ratio >= 1.5) return "hit";
  if (ratio >= 0.7) return "on_track";
  return "underperformed";
}

// Reviews compound. First at 48h to give early signal, second at 7d
// for the final reading. After 7d we stop scheduling — the verdict is
// settled.
function pickNextReviewAt(
  postedAt: Date,
  now = new Date(),
): Date | null {
  const FORTY_EIGHT_H_MS = 48 * 60 * 60 * 1000;
  const SEVEN_D_MS = 7 * 24 * 60 * 60 * 1000;
  const ageMs = now.getTime() - postedAt.getTime();
  if (ageMs < FORTY_EIGHT_H_MS) {
    return new Date(postedAt.getTime() + FORTY_EIGHT_H_MS);
  }
  if (ageMs < SEVEN_D_MS) {
    return new Date(postedAt.getTime() + SEVEN_D_MS);
  }
  return null;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

const PLATFORM_PROSE: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube Shorts",
  instagram: "Instagram Reels",
};

function buildPrompt(args: {
  platform?: string;
  idea: {
    title: string;
    kind: string;
    format: string | null;
    hook: string | null;
    rationale: string | null;
    hashtags: string[] | null;
  };
  posted: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    engagement_rate: number;
    hours_since_posted: number;
  };
  baseline_median_rate: number;
  ratio: number;
  verdict: ReviewVerdict;
}): string {
  const platformLabel = PLATFORM_PROSE[args.platform ?? "tiktok"] ?? "TikTok";
  return `You are a ${platformLabel} content analyst writing a SHORT post-mortem on a video the creator just posted.

THE IDEA THAT WAS PRODUCED:
- Title: ${args.idea.title}
- Kind: ${args.idea.kind}
- Format: ${args.idea.format ?? "(unspecified)"}
- Hook: ${args.idea.hook ?? "(unspecified)"}
- Hashtags used: ${args.idea.hashtags?.join(", ") ?? "(unspecified)"}
- Why it was generated: ${args.idea.rationale ?? "(unspecified)"}

ACTUAL PERFORMANCE (${args.posted.hours_since_posted.toFixed(0)}h since post):
- Views: ${args.posted.views.toLocaleString()}
- Likes: ${args.posted.likes.toLocaleString()}
- Comments: ${args.posted.comments.toLocaleString()}
- Shares: ${args.posted.shares.toLocaleString()}
- Engagement rate (likes ÷ views): ${(args.posted.engagement_rate * 100).toFixed(2)}%

BASELINE (creator's median across recent videos):
- Median engagement rate: ${(args.baseline_median_rate * 100).toFixed(2)}%
- This video's ratio vs median: ${args.ratio.toFixed(2)}× — VERDICT: ${args.verdict}

Write a markdown post-mortem with this exact structure:

### Verdict
A single sentence stating the verdict and the ratio (e.g. "Hit — 2.1× your median engagement rate.").

### Why this likely landed where it did
2-3 sentences hypothesizing the actual cause. Be specific and grounded in the idea's choices (format, hook, hashtag mix, timing) — not vague platitudes. Cite the rationale at creation time and compare to what actually happened.

### Takeaways for the next video
- 3-5 short bullets. Each bullet is concrete enough to act on next time ("Keep the comparison hook — both 'hit' videos use it", not "make better content").

Be honest. If it underperformed, name the likely reason. If it hit, name what specifically worked. Do not pad. Do not invent stats.`;
}


// ─────────────────────────────────────────────────────────────────────
// Video metadata fetchers — used by the "import existing video" flow
// to populate a synthetic video_ideas row's title + posted_at from
// the platform itself, given just a URL + access token.
// ─────────────────────────────────────────────────────────────────────

export type ImportedVideoMetadata = {
  videoId: string;
  title: string | null;
  postedAt: string; // ISO 8601
  url: string | null;
};

async function fetchTikTokVideoMeta(
  token: string,
  videoId: string,
): Promise<ImportedVideoMetadata | null> {
  const data = (await tt(token, "/video/query/", {
    method: "POST",
    query: { fields: TT_FIELDS },
    body: { filters: { video_ids: [videoId] } },
  })) as { data?: { videos?: TikTokVideo[] } };
  const v = data.data?.videos?.[0];
  if (!v) return null;
  return {
    videoId,
    title: v.title ?? v.video_description ?? null,
    postedAt: v.create_time
      ? new Date(v.create_time * 1000).toISOString()
      : new Date().toISOString(),
    url: null,
  };
}

async function fetchYouTubeVideoMeta(
  token: string,
  videoId: string,
): Promise<ImportedVideoMetadata | null> {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: { title?: string; publishedAt?: string };
    }>;
  };
  const v = json.items?.[0];
  if (!v) return null;
  return {
    videoId: v.id,
    title: v.snippet?.title ?? null,
    postedAt: v.snippet?.publishedAt ?? new Date().toISOString(),
    url: `https://www.youtube.com/watch?v=${v.id}`,
  };
}

async function fetchInstagramVideoMeta(
  token: string,
  shortcode: string,
): Promise<ImportedVideoMetadata | null> {
  const mediaId = await fetchInstagramMediaIdByShortcode(token, shortcode);
  if (!mediaId) return null;
  const res = await fetch(
    `https://graph.instagram.com/${mediaId}?fields=caption,timestamp,permalink&access_token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    caption?: string;
    timestamp?: string;
    permalink?: string;
  };
  // IG has no separate title field — first ~80 chars of the caption is
  // the closest equivalent the user would recognise as a "title".
  const title = json.caption
    ? json.caption.split("\n")[0]!.slice(0, 80)
    : null;
  return {
    videoId: shortcode, // keep the shortcode as the canonical id we store
    title,
    postedAt: json.timestamp ?? new Date().toISOString(),
    url: json.permalink ?? null,
  };
}

// Public dispatcher: given a platform + access token + the URL/id the
// user pasted, returns the video's title + posted_at + canonical id.
// Returns null when the platform can't find the video (most often
// because the URL points to a video that doesn't belong to this
// integration's account — e.g. someone else's TikTok).
export async function fetchImportedVideoMetadata(
  platform: string,
  token: string,
  urlOrId: string,
): Promise<ImportedVideoMetadata | null> {
  const id = extractPostedVideoId(platform, urlOrId);
  if (!id) return null;
  if (platform === "tiktok") return fetchTikTokVideoMeta(token, id);
  if (platform === "youtube") return fetchYouTubeVideoMeta(token, id);
  if (platform === "instagram") return fetchInstagramVideoMeta(token, id);
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Per-platform-post review. New entry point for the multi-platform
// post model — operates on a video_idea_posts row.
// ─────────────────────────────────────────────────────────────────────

export async function runPostReview({
  supabase,
  userId,
  postId,
  now = new Date(),
}: {
  supabase: SupabaseClient;
  userId: string;
  postId: string;
  now?: Date;
}): Promise<ReviewResult> {
  // 1. Load the post row + the parent idea.
  const { data: post } = await supabase
    .from("video_idea_posts")
    .select(
      "id, idea_id, integration_id, platform, posted_video_id, posted_at",
    )
    .eq("user_id", userId)
    .eq("id", postId)
    .maybeSingle();
  if (!post) return { ok: false, error: "Post not found." };

  const { data: idea } = await supabase
    .from("video_ideas")
    .select("title, kind, format, hook, rationale, hashtags")
    .eq("user_id", userId)
    .eq("id", post.idea_id)
    .maybeSingle();
  if (!idea) return { ok: false, error: "Parent idea not found." };

  // 2. Load the integration + fresh token.
  const { data: integration } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("user_id", userId)
    .eq("id", post.integration_id)
    .maybeSingle();
  if (!integration) return { ok: false, error: "Integration not found." };
  if (!integration.encrypted_access_token) {
    return { ok: false, error: "No access token stored." };
  }

  let token: string;
  try {
    token = await getFreshAccessToken(
      supabase,
      userId,
      integration.provider as "tiktok" | "youtube" | "instagram",
      {
        id: integration.id as string,
        encrypted_access_token: integration.encrypted_access_token,
        encrypted_refresh_token: integration.encrypted_refresh_token,
        expires_at: integration.expires_at,
      },
    );
  } catch {
    token = decrypt(integration.encrypted_access_token);
  }

  // 3. Pull stats + baseline by platform.
  const platform = post.platform as string;
  let stats: PlatformStats | null = null;
  let baselineRates: number[] = [];
  try {
    if (platform === "tiktok") {
      stats = await fetchTikTokStats(token, post.posted_video_id as string);
      baselineRates = await fetchTikTokBaselineRates(token);
    } else if (platform === "youtube") {
      stats = await fetchYouTubeStats(token, post.posted_video_id as string);
      baselineRates = await fetchYouTubeBaselineRates(token);
    } else if (platform === "instagram") {
      stats = await fetchInstagramStats(
        token,
        post.posted_video_id as string,
      );
      baselineRates = await fetchInstagramBaselineRates(token);
    } else {
      return { ok: false, error: `Unsupported platform: ${platform}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: `${platform} stats fetch failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  if (!stats) {
    return { ok: false, error: `${platform} returned no data for this post.` };
  }

  const baselineMedianRate = median(baselineRates);
  const views = stats.views;
  const likes = stats.likes;
  const comments = stats.comments;
  const shares = stats.shares;
  const engagementRate = views > 0 ? likes / views : 0;
  const ratio =
    baselineMedianRate > 0 ? engagementRate / baselineMedianRate : 0;

  const postedAt = new Date(post.posted_at as string);
  const hoursSincePosted = (now.getTime() - postedAt.getTime()) / 3_600_000;
  const verdict = pickVerdict(ratio, hoursSincePosted);
  const nextReviewAt = pickNextReviewAt(postedAt, now);

  // 4. LLM prose post-mortem.
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
    return { ok: false, error: `Unknown AI provider: ${provider}` };
  }
  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch {
    return { ok: false, error: "Could not decrypt AI provider key." };
  }

  let reviewText = "";
  try {
    const result = await generateText({
      model: getModel(provider, apiKey, userModel),
      system: buildPrompt({
        platform,
        idea: {
          title: idea.title as string,
          kind: idea.kind as string,
          format: idea.format as string | null,
          hook: idea.hook as string | null,
          rationale: idea.rationale as string | null,
          hashtags: (idea.hashtags as string[] | null) ?? [],
        },
        posted: {
          views,
          likes,
          comments,
          shares,
          engagement_rate: engagementRate,
          hours_since_posted: hoursSincePosted,
        },
        baseline_median_rate: baselineMedianRate,
        ratio,
        verdict,
      }),
      messages: [
        {
          role: "user",
          content:
            "Write the post-mortem now. Return only the markdown — no preamble.",
        },
      ],
    });
    reviewText = result.text.trim();
  } catch (err) {
    return {
      ok: false,
      error: `Model call failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  return {
    ok: true,
    verdict,
    score: engagementRate,
    review: reviewText,
    stats: {
      views,
      likes,
      comments,
      shares,
      engagement_rate: engagementRate,
      baseline_median_rate: baselineMedianRate,
      ratio,
      hours_since_posted: hoursSincePosted,
    },
    next_review_at: nextReviewAt,
  };
}

// Persist a per-post review result.
export async function savePostReview(
  supabase: SupabaseClient,
  userId: string,
  postId: string,
  result: ReviewResult,
): Promise<{ ok: boolean; error?: string }> {
  if (!result.ok) return { ok: false, error: result.error };
  const { error } = await supabase
    .from("video_idea_posts")
    .update({
      performance_verdict: result.verdict ?? null,
      performance_score: result.score ?? null,
      performance_review: result.review ?? null,
      performance_stats: result.stats ?? null,
      last_reviewed_at: new Date().toISOString(),
      next_review_at: result.next_review_at
        ? result.next_review_at.toISOString()
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", postId);
  return { ok: !error, error: error?.message };
}

export async function runVideoReview({
  supabase,
  userId,
  ideaId,
  now = new Date(),
}: {
  supabase: SupabaseClient;
  userId: string;
  ideaId: string;
  now?: Date;
}): Promise<ReviewResult> {
  // 1. Load the idea + verify ownership + ensure it's linked to a video.
  const { data: idea } = await supabase
    .from("video_ideas")
    .select(
      "id, integration_id, kind, title, format, hook, rationale, hashtags, posted_video_id, posted_at",
    )
    .eq("user_id", userId)
    .eq("id", ideaId)
    .maybeSingle();
  if (!idea) return { ok: false, error: "Idea not found." };
  if (!idea.posted_video_id) {
    return { ok: false, error: "Idea has no linked TikTok video." };
  }
  if (!idea.posted_at) {
    return { ok: false, error: "Idea is missing posted_at." };
  }

  // 2. Load the integration + fresh access token.
  const { data: integration } = await supabase
    .from("integrations")
    .select(
      "id, provider, encrypted_access_token, encrypted_refresh_token, expires_at",
    )
    .eq("user_id", userId)
    .eq("id", idea.integration_id)
    .maybeSingle();
  if (!integration) {
    return { ok: false, error: "Integration not found." };
  }
  if (integration.provider !== "tiktok") {
    return { ok: false, error: "Only TikTok reviews are implemented." };
  }
  if (!integration.encrypted_access_token) {
    return { ok: false, error: "No access token stored." };
  }

  let token: string;
  try {
    token = await getFreshAccessToken(supabase, userId, "tiktok", {
      encrypted_access_token: integration.encrypted_access_token,
      encrypted_refresh_token: integration.encrypted_refresh_token,
      expires_at: integration.expires_at,
    });
  } catch {
    token = decrypt(integration.encrypted_access_token);
  }

  // 3. Pull the posted video's current stats.
  let posted: TikTokVideo | undefined;
  try {
    const data = (await tt(token, "/video/query/", {
      method: "POST",
      query: { fields: TT_FIELDS },
      body: { filters: { video_ids: [idea.posted_video_id] } },
    })) as { data?: { videos?: TikTokVideo[] } };
    posted = data.data?.videos?.[0];
  } catch (err) {
    return {
      ok: false,
      error: `Failed to load video: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  if (!posted) {
    return { ok: false, error: "TikTok returned no data for this video id." };
  }

  // 4. Pull the baseline — last 20 of the creator's videos by date.
  let baselineVideos: TikTokVideo[] = [];
  try {
    const data = (await tt(token, "/video/list/", {
      method: "POST",
      query: { fields: TT_FIELDS },
      body: { max_count: 20 },
    })) as { data?: { videos?: TikTokVideo[] } };
    baselineVideos = data.data?.videos ?? [];
  } catch {
    // Non-fatal — we just won't have a great baseline.
  }

  const VIEW_FLOOR = 50;
  const baselineRates = baselineVideos
    .filter((v) => (v.view_count ?? 0) >= VIEW_FLOOR && v.id !== idea.posted_video_id)
    .map((v) => (v.like_count ?? 0) / Math.max(1, v.view_count ?? 1));
  const baselineMedianRate = median(baselineRates);

  const views = posted.view_count ?? 0;
  const likes = posted.like_count ?? 0;
  const comments = posted.comment_count ?? 0;
  const shares = posted.share_count ?? 0;
  const engagementRate = views > 0 ? likes / views : 0;
  const ratio =
    baselineMedianRate > 0 ? engagementRate / baselineMedianRate : 0;

  const postedAt = new Date(idea.posted_at);
  const hoursSincePosted = (now.getTime() - postedAt.getTime()) / 3_600_000;
  const verdict = pickVerdict(ratio, hoursSincePosted);
  const nextReviewAt = pickNextReviewAt(postedAt, now);

  // 5. Resolve AI key (BYOK, first configured).
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
    return { ok: false, error: `Unknown AI provider: ${provider}` };
  }
  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch {
    return { ok: false, error: "Could not decrypt AI provider key." };
  }

  // 6. Ask the model for the prose post-mortem.
  let reviewText = "";
  try {
    const result = await generateText({
      model: getModel(provider, apiKey, userModel),
      system: buildPrompt({
        idea: {
          title: idea.title as string,
          kind: idea.kind as string,
          format: idea.format as string | null,
          hook: idea.hook as string | null,
          rationale: idea.rationale as string | null,
          hashtags: (idea.hashtags as string[] | null) ?? [],
        },
        posted: {
          views,
          likes,
          comments,
          shares,
          engagement_rate: engagementRate,
          hours_since_posted: hoursSincePosted,
        },
        baseline_median_rate: baselineMedianRate,
        ratio,
        verdict,
      }),
      messages: [
        {
          role: "user",
          content:
            "Write the post-mortem now. Return only the markdown — no preamble.",
        },
      ],
    });
    reviewText = result.text.trim();
  } catch (err) {
    return {
      ok: false,
      error: `Model call failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  return {
    ok: true,
    verdict,
    score: engagementRate,
    review: reviewText,
    stats: {
      views,
      likes,
      comments,
      shares,
      engagement_rate: engagementRate,
      baseline_median_rate: baselineMedianRate,
      ratio,
      hours_since_posted: hoursSincePosted,
    },
    next_review_at: nextReviewAt,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Cross-platform synthesis.
//
// The per-post reviews above answer "how did this video do on each
// platform?" — but the creator shot ONCE and uploaded the same thing
// everywhere, so the more useful read is "how did the SAME shoot do
// across the platforms?". A 2.1× hit on TikTok + 0.4× flop on
// Instagram tells the creator something specific (IG audience expects
// shorter setup, the hook isn't translating, etc.) that no per-post
// review can.
//
// runIdeaSynthesis aggregates the saved per-platform reviews into one
// markdown post-mortem on the parent video_ideas row. It only runs
// when 2+ sibling posts have settled (non-too_early verdicts). With a
// single post, the per-platform review IS the review — no synthesis
// added value. Idempotent: re-running overwrites with whatever the
// latest per-platform reviews say.
// ─────────────────────────────────────────────────────────────────────

type SettledPost = {
  platform: string;
  posted_video_url: string | null;
  performance_verdict: ReviewVerdict;
  performance_review: string | null;
  performance_stats: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    engagement_rate?: number;
    baseline_median_rate?: number;
    ratio?: number;
  } | null;
};

export type SynthesisResult = {
  ok: boolean;
  verdict?: ReviewVerdict;
  review?: string;
  posts?: SettledPost[];
  error?: string;
};

function aggregateVerdict(posts: SettledPost[]): ReviewVerdict {
  const verdicts = posts.map((p) => p.performance_verdict);
  if (verdicts.includes("hit")) return "hit";
  if (verdicts.every((v) => v === "underperformed")) return "underperformed";
  return "on_track";
}

function synthesisPrompt(
  idea: {
    title: string;
    kind: string;
    format: string | null;
    hook: string | null;
    rationale: string | null;
  },
  posts: SettledPost[],
  aggregate: ReviewVerdict,
): string {
  const lines: string[] = [];
  lines.push(
    `You are a multi-platform content analyst writing a CROSS-PLATFORM synthesis post-mortem. The creator shot one video and uploaded the same cut to ${posts.length} platforms; this synthesis is about how the SAME shoot performed differently (or similarly) across them.`,
  );
  lines.push("");
  lines.push("THE IDEA:");
  lines.push(`- Title: ${idea.title}`);
  lines.push(`- Kind: ${idea.kind}`);
  lines.push(`- Format: ${idea.format ?? "(unspecified)"}`);
  lines.push(`- Hook: ${idea.hook ?? "(unspecified)"}`);
  lines.push(`- Why it was generated: ${idea.rationale ?? "(unspecified)"}`);
  lines.push("");
  lines.push("PER-PLATFORM OUTCOMES:");
  for (const p of posts) {
    const label = PLATFORM_PROSE[p.platform] ?? p.platform;
    const s = p.performance_stats ?? {};
    const ratioStr =
      s.ratio != null ? `${s.ratio.toFixed(2)}× the creator's median` : "?";
    lines.push(
      `- ${label}: ${p.performance_verdict.toUpperCase()} · ${ratioStr} · ${
        s.views ?? 0
      }v / ${s.likes ?? 0}l / ${s.comments ?? 0}c / ${s.shares ?? 0}s`,
    );
    if (p.performance_review) {
      // Pull just the "Why" + "Takeaways" parts of each per-platform
      // review so the synthesis model sees the analyst's reasoning,
      // not just numbers.
      const condensed = p.performance_review
        .split(/\n+/)
        .filter((l) => !/^#+\s*Verdict/i.test(l))
        .join("\n")
        .slice(0, 700);
      lines.push(`  Per-platform analyst notes: ${condensed}`);
    }
  }
  lines.push("");
  lines.push(`AGGREGATE VERDICT: ${aggregate.toUpperCase()}`);
  lines.push("");
  lines.push(`Write a markdown synthesis with this exact structure:

### Cross-platform verdict
One sentence describing how the same shoot performed across the ${posts.length} platforms — specifically calling out divergence if there was any (e.g. "Hit on TikTok at 2.1× but flopped on Instagram at 0.4× — clear audience-fit divergence.")

### Why the platforms diverged (or aligned)
2-4 sentences. If divergence: name the most likely cause — algo differences (TT's For You vs YT's subscriber-feed weighting vs IG's Explore mix), audience expectations (IG expects shorter setup, YT rewards search-keyword titles, TT rewards hook within 1s), format fit, or hashtag/discovery differences. If alignment: name what specifically translated across the board.

### Takeaways for the next cross-platform shoot
- 3-5 short bullets. Each bullet is concrete and platform-aware ("Cut 2s off the intro before posting to IG — keep the full version for YT description and TT", not "make better content"). At least one bullet must be platform-specific.

Be specific. Do not invent stats. Do not pad. No preamble — return only the markdown.`);
  return lines.join("\n");
}

export async function runIdeaSynthesis({
  supabase,
  userId,
  ideaId,
}: {
  supabase: SupabaseClient;
  userId: string;
  ideaId: string;
}): Promise<SynthesisResult> {
  const { data: idea } = await supabase
    .from("video_ideas")
    .select("title, kind, format, hook, rationale")
    .eq("user_id", userId)
    .eq("id", ideaId)
    .maybeSingle();
  if (!idea) return { ok: false, error: "Idea not found." };

  const { data: postRows } = await supabase
    .from("video_idea_posts")
    .select(
      "platform, posted_video_url, performance_verdict, performance_review, performance_stats",
    )
    .eq("user_id", userId)
    .eq("idea_id", ideaId);

  const settled: SettledPost[] = [];
  for (const p of postRows ?? []) {
    const v = p.performance_verdict as ReviewVerdict | null;
    if (!v || v === "too_early") continue;
    settled.push({
      platform: p.platform as string,
      posted_video_url: (p.posted_video_url as string | null) ?? null,
      performance_verdict: v,
      performance_review: (p.performance_review as string | null) ?? null,
      performance_stats:
        (p.performance_stats as SettledPost["performance_stats"]) ?? null,
    });
  }
  if (settled.length < 2) {
    // Single-post idea — no synthesis to add. Not an error; the caller
    // can skip persisting.
    return { ok: false, error: "Need 2+ settled posts for synthesis." };
  }

  const aggregate = aggregateVerdict(settled);

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
    return { ok: false, error: `Unknown AI provider: ${provider}` };
  }
  let apiKey: string;
  try {
    apiKey = decrypt(encrypted_key);
  } catch {
    return { ok: false, error: "Could not decrypt AI provider key." };
  }

  try {
    const result = await generateText({
      model: getModel(provider, apiKey, userModel),
      system: synthesisPrompt(
        {
          title: idea.title as string,
          kind: idea.kind as string,
          format: idea.format as string | null,
          hook: idea.hook as string | null,
          rationale: idea.rationale as string | null,
        },
        settled,
        aggregate,
      ),
      messages: [
        {
          role: "user",
          content:
            "Write the cross-platform synthesis now. Markdown only, no preamble.",
        },
      ],
    });
    return {
      ok: true,
      verdict: aggregate,
      review: result.text.trim(),
      posts: settled,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Model call failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

// Persist a synthesis onto the parent video_ideas row. Aggregate
// engagement_rate / ratio are averaged across platforms so the headline
// number on the card still means "this shoot did roughly Nx".
export async function saveIdeaSynthesis(
  supabase: SupabaseClient,
  userId: string,
  ideaId: string,
  synthesis: SynthesisResult,
): Promise<{ ok: boolean; error?: string }> {
  if (!synthesis.ok || !synthesis.posts) {
    return { ok: false, error: synthesis.error };
  }
  const ratios = synthesis.posts
    .map((p) => p.performance_stats?.ratio)
    .filter((r): r is number => typeof r === "number");
  const avgRatio = ratios.length
    ? ratios.reduce((a, b) => a + b, 0) / ratios.length
    : 0;
  const totalViews = synthesis.posts.reduce(
    (a, p) => a + (p.performance_stats?.views ?? 0),
    0,
  );
  const totalLikes = synthesis.posts.reduce(
    (a, p) => a + (p.performance_stats?.likes ?? 0),
    0,
  );
  const totalComments = synthesis.posts.reduce(
    (a, p) => a + (p.performance_stats?.comments ?? 0),
    0,
  );
  const totalShares = synthesis.posts.reduce(
    (a, p) => a + (p.performance_stats?.shares ?? 0),
    0,
  );
  const aggregateStats = {
    views: totalViews,
    likes: totalLikes,
    comments: totalComments,
    shares: totalShares,
    ratio: avgRatio,
    cross_platform: true,
    platform_count: synthesis.posts.length,
  };
  const { error } = await supabase
    .from("video_ideas")
    .update({
      performance_verdict: synthesis.verdict ?? null,
      performance_review: synthesis.review ?? null,
      performance_stats: aggregateStats,
      last_reviewed_at: new Date().toISOString(),
    })
    .eq("user_id", userId)
    .eq("id", ideaId);
  return { ok: !error, error: error?.message };
}

// Persist a review result to the idea row.
export async function saveReview(
  supabase: SupabaseClient,
  userId: string,
  ideaId: string,
  result: ReviewResult,
): Promise<{ ok: boolean; error?: string }> {
  if (!result.ok) return { ok: false, error: result.error };
  const { error } = await supabase
    .from("video_ideas")
    .update({
      performance_verdict: result.verdict ?? null,
      performance_score: result.score ?? null,
      performance_review: result.review ?? null,
      performance_stats: result.stats ?? null,
      last_reviewed_at: new Date().toISOString(),
      next_review_at: result.next_review_at
        ? result.next_review_at.toISOString()
        : null,
    })
    .eq("user_id", userId)
    .eq("id", ideaId);
  return { ok: !error, error: error?.message };
}

// Re-export URL parsers so the existing API surface
// (`@agentflow/core`) keeps working — callers import these from this
// module's wildcard re-export.
export {
  extractInstagramShortcode,
  extractPostedVideoId,
  extractTikTokVideoId,
  extractYouTubeVideoId,
} from "./video-review/url-parsers";
