import type { SupabaseClient } from "@supabase/supabase-js";
import { generateText } from "ai";
import { decrypt } from "../crypto";
import { getModel, isProvider } from "../ai-providers";
import { getFreshAccessToken } from "../oauth-refresh";

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

type TikTokVideo = {
  id?: string;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  share_count?: number;
  create_time?: number;
  title?: string;
  video_description?: string;
};

const TT_FIELDS = [
  "id",
  "view_count",
  "like_count",
  "comment_count",
  "share_count",
  "create_time",
  "title",
  "video_description",
].join(",");

async function tt(
  token: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string> } = {},
): Promise<unknown> {
  const url = new URL(`https://open.tiktokapis.com/v2${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`TikTok ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

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

function buildPrompt(args: {
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
  return `You are a TikTok content analyst writing a SHORT post-mortem on a video the creator just posted.

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

// TikTok URLs look like https://www.tiktok.com/@user/video/<numeric_id>
// or sometimes https://vm.tiktok.com/<short>. We extract the numeric id
// when present. Short URLs we can't resolve without a HEAD redirect —
// caller can choose to follow.
export function extractTikTokVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const m = trimmed.match(/\/video\/(\d{6,})/);
  if (m && m[1]) return m[1];
  // Some users paste just the numeric id.
  if (/^\d{6,}$/.test(trimmed)) return trimmed;
  return null;
}

// YouTube IDs are 11-char URL-safe base64. Handle:
//   • https://youtube.com/watch?v=XXXX
//   • https://youtu.be/XXXX
//   • https://youtube.com/shorts/XXXX
//   • plain id
export function extractYouTubeVideoId(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // shorts/<id>
  let m = trimmed.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
  if (m && m[1]) return m[1].slice(0, 11);
  // watch?v=<id>
  m = trimmed.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m && m[1]) return m[1].slice(0, 11);
  // youtu.be/<id>
  m = trimmed.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m && m[1]) return m[1].slice(0, 11);
  // bare 11-char id
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

// Instagram media IDs aren't in the URL directly — the URL uses a
// short "shortcode" (e.g. https://instagram.com/reel/Cxxxx/). We store
// the shortcode and resolve to the API media id at review time.
export function extractInstagramShortcode(url: string): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  // /reel/CODE/ or /p/CODE/ or /tv/CODE/
  const m = trimmed.match(
    /instagram\.com\/(?:reel|p|tv)\/([A-Za-z0-9_-]{5,})/i,
  );
  if (m && m[1]) return m[1];
  // Bare-ish shortcode
  if (/^[A-Za-z0-9_-]{5,20}$/.test(trimmed)) return trimmed;
  return null;
}

// Generic dispatch — pass the platform + a URL/id and get a normalized
// provider-side id back. Returns null when nothing parseable.
export function extractPostedVideoId(
  platform: string,
  urlOrId: string,
): string | null {
  switch (platform) {
    case "tiktok":
      return extractTikTokVideoId(urlOrId);
    case "youtube":
      return extractYouTubeVideoId(urlOrId);
    case "instagram":
      return extractInstagramShortcode(urlOrId);
    default:
      return null;
  }
}
