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

export type VideoIdeaKind =
  | "pattern"
  | "trend"
  | "rising"
  | "competitor"
  | "seasonal";

export type GeneratedIdea = {
  title: string;
  hook?: string;
  format?: string;
  rationale?: string;
  kind: VideoIdeaKind;
  source_refs?: Record<string, unknown>;
  /** Only meaningful for seasonal — a hard date the idea should ship by. */
  hard_date?: string;
  /** Free-text warning when the format/topic shows saturation signals.
   *  Surfaces on the card so the user understands the recommended twist. */
  saturation_warning?: string;
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
  // Virality-tuning fields:
  /** When to post for best reach ("Tue-Thu 7-9pm local"). */
  optimal_post_window?: string;
  /** Recommended length range ("18-25s"). */
  suggested_duration?: string;
  /** What the first frame should be — TikTok shows it as the cover. */
  thumbnail_concept?: string;
  /** Specific element designed to drive comments (distinct from the
   *  opening hook, which is about stopping the scroll). */
  engagement_hook?: string;
  /** Trending TikTok sound to use, if one fits. */
  trending_sound?: string;
  /** Per-platform caption packaging — only the platforms the creator
   *  has connected get a variant. Shoot is shared (the script/hook/
   *  visual_notes above); this is the metadata that goes around it. */
  platforms?: PlatformPack;
};

export type PlatformPack = {
  tiktok?: { caption: string; hashtags: string[] };
  youtube?: { title: string; description: string; hashtags: string[] };
  instagram?: { caption: string; hashtags: string[] };
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
  kind: z.enum(["pattern", "trend", "rising", "competitor", "seasonal"]),
  source_refs: z.record(z.string(), z.unknown()).nullish(),
  hard_date: z.string().nullish(),
  saturation_warning: z.string().nullish(),
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
  platforms: z
    .object({
      tiktok: z
        .object({
          caption: z.string(),
          hashtags: z.array(z.string()),
        })
        .nullish(),
      youtube: z
        .object({
          title: z.string(),
          description: z.string(),
          hashtags: z.array(z.string()),
        })
        .nullish(),
      instagram: z
        .object({
          caption: z.string(),
          hashtags: z.array(z.string()),
        })
        .nullish(),
    })
    .nullish(),
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

function describeYouTubeAvailable(): string {
  return [
    "- YouTube (your channel): youtube_get_my_channel, youtube_list_my_videos",
    "- Per-video deep stats (real watch time + traffic): youtube_get_video_analytics, youtube_get_video_traffic_sources",
    "- Niche/competitor discovery: youtube_search_niche (query, order, published_after_days)",
    "- Audience sentiment: youtube_get_video_comments",
    "- Uploaded analytics CSVs: list_my_analytics_uploads, get_analytics_upload",
  ].join("\n");
}

function describeInstagramAvailable(): string {
  return [
    "- Instagram (your account): instagram_get_my_account, instagram_list_my_media",
    "- Per-media insights (reach, saved, shares): instagram_get_media_insights",
    "- Account-level insights over time: instagram_get_account_insights",
    "- Audience sentiment: instagram_list_comments",
    "- Uploaded analytics CSVs: list_my_analytics_uploads, get_analytics_upload",
  ].join("\n");
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

function preferencesBlock(preferences: string | null): string {
  if (!preferences || !preferences.trim()) return "";
  return `

CREATOR PREFERENCES / HARD CONSTRAINTS (must respect for every idea — ideas that violate these are an automatic skip):
${preferences.trim()}`;
}

const PLATFORM_GUIDANCE: Record<string, string> = {
  tiktok:
    "TikTok — caption is a short punchy line (≤150 chars), then 5-7 hashtags. The caption is just the headline; the script-derived spoken content carries the real message. Keep it conversational, end with a soft hook or question to drive comments.",
  youtube:
    "YouTube Shorts — needs its own title (≤100 chars, search-optimised — front-load the keyword phrase, no leading hashtag in title) AND a longer description (3-5 paragraphs, can repeat the spoken content for the YT search index, links/credits welcome). Hashtags 3-5 max — YT only surfaces the first 3 above the video, anything past 15 disables them all.",
  instagram:
    "Instagram Reels — caption is storytelling-style (2-4 short paragraphs, can be ~2200 chars max but most reels do 150-400 chars). Lead with a hook line that survives the truncation cutoff (~125 chars). Hashtags 3-8, niche-focused — IG's algo penalises generic mass tags like #love.",
};

function platformsBlock(targetPlatforms: string[]): string {
  if (targetPlatforms.length === 0) return "";
  const lines = targetPlatforms
    .filter((p) => PLATFORM_GUIDANCE[p])
    .map((p) => `  • ${PLATFORM_GUIDANCE[p]}`);
  if (lines.length === 0) return "";
  return `\n\nPER-PLATFORM PACKAGING — the creator will cross-post this same shoot to ${targetPlatforms.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" + ")}. For every idea, write a tailored caption package for EACH platform in the platforms object. The script and visuals are shared; only the metadata around the upload differs per platform:\n${lines.join("\n")}\n\nDo not just copy the same caption across platforms — each must respect its platform's norms. Hashtags can overlap but each platform's list should be hand-picked for its own discovery system.`;
}

function tiktokPrompt(
  count: number,
  today: string,
  connected: string[],
  recentReviews: RecentReview[] = [],
  preferences: string | null = null,
  targetPlatforms: string[] = ["tiktok"],
): string {
  const hasApify = connected.includes("apify");
  const hasReviews = recentReviews.length > 0;
  return `You are a TikTok content strategist. Produce exactly ${count} fresh video ideas as a JSON object.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no "Here are the ideas", no analysis preamble, no markdown headers, no code fence, no clarifying questions, no offers to split the work. The response must START with the literal character \`{\` and END with \`}\`. If the request is ambiguous, pick the most reasonable interpretation from the tool data and proceed — never ask the user. The schema is at the bottom of this message — follow it exactly.

Today is ${today}. Tools:
${describeAvailable(connected)}
${reviewsBlock(recentReviews)}${preferencesBlock(preferences)}${platformsBlock(targetPlatforms)}

PROCEDURE
1. tiktok_top_my_videos (top_n 10, from_history 100) — lifetime best by engagement rate.
2. tiktok_list_my_videos (max_count 20) — current voice / pacing / topic focus.
3. Cross-reference: ideas hit top-10 patterns delivered in recent-20 voice.
4. Extract most-used hashtags from top performers.
4b. TIMING — from top-10 create_time, derive day-of-week + hour patterns (convert unix→UTC; assume audience in creator's TZ). Feeds optimal_post_window.
4c. AUDIO — scan top performers for music_meta / recurring audio.
${hasApify ? `5. For top 2-3 hashtags, tiktok_search_hashtag (limit 25):
   (a) trending right now;
   (b) VELOCITY: group by week. Past 3-7d top performers outperform prior 7-14d → ACCELERATING → seed rising-kind;
   (c) SATURATION: 15+ recent videos clearly below niche median → flag in saturation_warning;
   (d) 3-5 distinct non-user authors → competitors.
6. For 1-2 competitor handles, tiktok_get_profile (videos_limit 10).
7. list_my_analytics_uploads — any CSV uploads.` : `5. No Apify — skip competitor/trend/rising. Lean on pattern + seasonal.
6. list_my_analytics_uploads — any CSV uploads.`}

KINDS (balance across these)
- pattern: extrapolate from a winning format — a NEW song/topic that fits.
- ${hasApify ? `competitor: source_refs={competitor_handle, competitor_video_url}. Something they nailed and the user hasn't.` : `competitor: skip (no Apify).`}
- ${hasApify ? `trend: source_refs={hashtag, trending_sound?}. Currently visible, not yet saturated.` : `trend: skip (no Apify).`}
- ${hasApify ? `rising: velocity ACCELERATING last 3-7d. source_refs must include velocity_note. Max 1-2 per refresh.` : `rising: skip (no Apify).`}
- seasonal: calendar-anchored. hard_date in next 60 days (ISO 8601).

RULES
- Ground EVERY idea in a tool result — no invented stats, handles, or hashtags.
- title: specific + recordable ("Cover Hotel California — acoustic vs classical").
- hook: actual first spoken/shown line.
- format: short ("acoustic vs classical comparison").
- rationale: 1-2 sentences citing specific evidence.${hasReviews ? ` When a post-mortem above applies (same format/hook/topic), the rationale MUST cite it by title + verdict.` : ""}
- saturation_warning: short string only when you saw the SPECIFIC format with saturation signals; else null.

SCRIPT (one beat per line, timestamps, all cues explicit)
    [0:00-0:03] HOOK
      📢 SAY: "<exact words>" (or SHOW: silent text)
      🎬 ACTION: <on-camera>
      📺 ON-SCREEN TEXT: "<words>" (or "none")
      🎵 AUDIO: <music cue / original / ambient>
    [0:03-0:10] BEAT 1 — Setup
    [0:10-0:25] BEAT 2 — Payoff / Demo (include ✂️ CUT)
    [0:25-0:35] BEAT 3 — Twist / Comparison
    [0:35-0:40] CTA — exact ask + on-screen text + gesture
Each BEAT has SAY/ACTION/ON-SCREEN TEXT (and AUDIO/CUT where relevant). HOOK ≤3s, CTA ≤5s, total ≤60s. Match creator's voice from list/top tools.

CAPTION
- post_title: ≤100 chars, attention-grabbing.
- description: 2-3 short paragraphs ending with CTA. No inline hashtags.
- hashtags: 5-7 strings, no leading '#'. Mix broad-niche + specific + 1-2 trend tags you actually saw.
- cta: one explicit ask ("Comment 'nylon' or 'steel' below 👇").
- visual_notes: 4-6 bullets "• " (lighting, framing, props, B-roll, color grade).

VIRALITY
- optimal_post_window: "Tue-Thu 7-9pm local" (from step 4b; caveat if signal weak).
- suggested_duration: seconds, e.g. "18-25s" (comparison/demo 18-25s, tutorial 35-50s, teaser 7-12s).
- thumbnail_concept: ONE visual sentence ("close-up of two guitar headstocks, bold text 'WHICH SOUNDS BETTER?'").
- engagement_hook: SPECIFIC comment-driver, distinct from opening hook.
- trending_sound: name with sound id/URL if found in tool results; else null. Never invent.

Return ONLY a JSON object {ideas:[...]} matching:
{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "source_refs":{...}, "hard_date":string, "saturation_warning":string|null,
  "script":string, "post_title":string, "description":string,
  "hashtags":[string], "cta":string, "visual_notes":string,
  "optimal_post_window":string, "suggested_duration":string,
  "thumbnail_concept":string, "engagement_hook":string,
  "trending_sound":string|null,
  "platforms":{ "tiktok":{ "caption":string, "hashtags":[string] } }
}] }

Your LAST message is this JSON only — no prose, no code fence.`;
}

// ─────────────────────────────────────────────────────────────────────
// YouTube Shorts prompt — shoot-ready ideas tailored to YT's algo and
// audience. Key differences vs TikTok:
//   - Title is search-keyword-optimised (front-load the keyword phrase)
//   - Description doubles as the search-index payload (3-5 paragraphs)
//   - 3 hashtags max (YT only surfaces the first 3 above the video)
//   - Shorts ≤60s; the Hook still must land in the first 1-2s
//   - Algo rewards retention + click-through-rate, not raw hashtag virality
// ─────────────────────────────────────────────────────────────────────
function youtubePrompt(
  count: number,
  today: string,
  recentReviews: RecentReview[] = [],
  preferences: string | null = null,
): string {
  const hasReviews = recentReviews.length > 0;
  return `You are a YouTube Shorts content strategist. Produce exactly ${count} fresh Short ideas as a JSON object.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no "Here are the ideas", no analysis preamble, no markdown headers, no code fence, no clarifying questions, no offers to split the work. The response must START with the literal character \`{\` and END with \`}\`. If the request is ambiguous, pick the most reasonable interpretation from the tool data and proceed — never ask the user. The schema is at the bottom of this message — follow it exactly.

Today is ${today}. Tools:
${describeYouTubeAvailable()}
${reviewsBlock(recentReviews)}${preferencesBlock(preferences)}

PROCEDURE
1. youtube_get_my_channel — anchor "my channel". Note subs + upload cadence.
2. youtube_list_my_videos (limit 25) — title-keyword patterns + which titles got the most views vs channel median.
3. For the top 2-3 most-viewed recent videos: youtube_get_video_analytics + youtube_get_video_traffic_sources. The traffic-source breakdown (Search vs Browse vs Suggested) shows whether the channel grows on discovery or recommendations.
4. youtube_search_niche with queries from step-2 title-keywords (order=viewCount, published_after_days=30). Capture: high-view recent Shorts, common title hooks, non-user channels. 2-3 distinct queries.
5. For the most engaging recent video in step 4, youtube_get_video_comments for audience questions.
6. list_my_analytics_uploads — any YT Studio CSV.

KINDS
- pattern: source_refs={source_video_id, title}. Extrapolate from a top video.
- competitor: source_refs={competitor_channel, competitor_video_url}. Angle they nailed and user hasn't.
- trend: source_refs={query, example_url}. Currently surging in YT Search/Browse.
- rising: trend + explicit velocity (last 3-7d outperforming prior 7-14d for same query). Max 1-2 per refresh.
- seasonal: hard_date (ISO 8601), next 60 days only.

RULES
- Ground EVERY idea in a tool result — no invented stats, channels, or queries.
- title: search-keyword-optimised + clickable. Front-load the keyword ("Beginner Fingerstyle Riff in 30 Seconds").
- hook: actual first 1-2s (spoken + on-screen). Shorts retention dies fast.
- format: short ("comparison demo", "before/after tutorial").
- rationale: 1-2 sentences citing specific evidence.${hasReviews ? ` When a post-mortem above applies, the rationale MUST cite it by title + verdict.` : ""}
- saturation_warning: only when you saw the SPECIFIC format saturating; else null.

SCRIPT (timestamps, all cues explicit, max 60s total)
    [0:00-0:02] HOOK
      📢 SAY: "<exact words>"
      🎬 ACTION: <on-camera>
      📺 ON-SCREEN TEXT: "<words>"
      🎵 AUDIO: <cue>
    [0:02-0:15] BEAT 1 — Setup
    [0:15-0:35] BEAT 2 — Payoff / Demo (include ✂️ CUT)
    [0:35-0:50] BEAT 3 — Twist / Comparison
    [0:50-1:00] CTA — exact ask + ON-SCREEN TEXT ("SUBSCRIBE" / "COMMENT YOUR PICK")
HOOK ≤2s, CTA ≤8s, total ≤60s. Match creator's voice from youtube_list_my_videos.

CAPTION
- post_title: ≤100 chars. Front-load keyword. "#Shorts" only if natural.
- description: 3-5 short paragraphs (the search-index payload — repeat spoken keywords). Ends with CTA. No inline hashtags.
- hashtags: EXACTLY 3 strings, no leading '#'. YT only surfaces the first 3.
- cta: one explicit ask ("Subscribe for more 30-second riffs every Friday").
- visual_notes: 4-6 bullets "• " (lighting, framing 9:16, props, B-roll, color grade).

VIRALITY
- optimal_post_window: "Tue-Thu 4-6pm local" (derive from analytics; caveat if weak signal).
- suggested_duration: seconds, ≤60. Comparison/tutorial 30-45s, high-energy hook 12-20s.
- thumbnail_concept: ONE visual sentence — the cover frame.
- engagement_hook: SPECIFIC comment/replay driver.
- trending_sound: null. (YT uses its own audio library; no algorithmic trending sound.)

Return ONLY a JSON object {ideas:[...]} matching:
{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "source_refs":{...}, "hard_date":string, "saturation_warning":string|null,
  "script":string, "post_title":string, "description":string,
  "hashtags":[string,string,string], "cta":string, "visual_notes":string,
  "optimal_post_window":string, "suggested_duration":string,
  "thumbnail_concept":string, "engagement_hook":string,
  "trending_sound":null,
  "platforms":{ "youtube":{ "title":string, "description":string, "hashtags":[string,string,string] } }
}] }

Your LAST message is this JSON only — no prose, no code fence.`;
}

// ─────────────────────────────────────────────────────────────────────
// Instagram Reels prompt. Key differences vs TT/YT:
//   - Caption is storytelling-style; the first ~125 chars must survive
//     IG's "more" truncation
//   - 3-8 hashtags, niche-focused; generic mass tags are penalised
//   - IG's discovery is Explore + Reels feed; algo weights saves +
//     shares + watch-completion heavily
//   - No trending_sound from API (Instagram doesn't expose it without
//     scraping); set to null
// ─────────────────────────────────────────────────────────────────────
function instagramPrompt(
  count: number,
  today: string,
  recentReviews: RecentReview[] = [],
  preferences: string | null = null,
): string {
  const hasReviews = recentReviews.length > 0;
  return `You are an Instagram Reels content strategist. Produce exactly ${count} fresh Reels ideas as a JSON object.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no "Here are the ideas", no analysis preamble, no markdown headers, no code fence, no clarifying questions, no offers to split the work. The response must START with the literal character \`{\` and END with \`}\`. If the request is ambiguous, pick the most reasonable interpretation from the tool data and proceed — never ask the user. The schema is at the bottom of this message — follow it exactly.

Today is ${today}. Tools:
${describeInstagramAvailable()}
${reviewsBlock(recentReviews)}${preferencesBlock(preferences)}

PROCEDURE
1. instagram_get_my_account — anchor "my account". Note followers + bio.
2. instagram_list_my_media (limit 25) — caption style, hashtag patterns, which media beat the median on likes/comments.
3. For top 3-5 recent Reels, instagram_get_media_insights. Reach + saves + shares matter MORE than likes; high saves = save-worthy concept.
4. instagram_get_account_insights (days 30) — reach + profile-view trends.
5. For the highest-engagement recent Reel, instagram_list_comments for audience questions.

KINDS
- pattern: source_refs={source_media_id, permalink}. Extrapolate from a top Reel.
- competitor: SKIP unless a post-mortem above cites one (IG API has no niche search).
- trend: only if user's own insights show a format clearly gaining (e.g. carousels up vs Reels). Cite the evidence.
- rising: SKIP unless user's engagement clearly accelerating on a specific format. Max 0-1 per refresh.
- seasonal: hard_date (ISO 8601), next 60 days only.

RULES
- Ground EVERY idea in a tool result — no invented stats or competitors.
- title: specific + recordable.
- hook: actual first 1-2s — both spoken AND first on-screen text frame (IG viewers scroll on mute).
- format: short ("save-worthy carousel cover", "tutorial Reel").
- rationale: 1-2 sentences citing specific evidence.${hasReviews ? ` When a post-mortem above applies, cite it by title + verdict.` : ""}
- saturation_warning: only when user's own insights show saturation; else null.

SCRIPT (timestamps, all cues, max 90s — sweet spot 25-45s)
    [0:00-0:02] HOOK
      📢 SAY: "<exact words>"
      🎬 ACTION: <on-camera>
      📺 ON-SCREEN TEXT: "<words>" (viewers scroll on mute — text carries the hook)
      🎵 AUDIO: <cue>
    [0:02-0:10] BEAT 1 — Setup
    [0:10-0:25] BEAT 2 — Payoff (include ✂️ CUT)
    [0:25-0:35] BEAT 3 — Save-worthy moment (ON-SCREEN TEXT must summarise the takeaway in one screenshot-able frame)
    [0:35-0:40] CTA — exact ask + ON-SCREEN TEXT ("SAVE FOR LATER" / "COMMENT YOUR PICK")
HOOK ≤2s, CTA ≤5s. Match creator's voice from instagram_list_my_media.

CAPTION
- post_title: same as caption opener (≤125 chars — what survives feed truncation).
- description: storytelling caption, 2-4 short paragraphs (line breaks). Under 500 chars unless format demands more. Ends with CTA. No inline hashtags.
- hashtags: 3-8 strings, no leading '#'. Niche-focused — avoid generic mass tags (#love, #instagood). Mix niche + 1-2 trend tags you saw.
- cta: one explicit ask. Algo weights SAVE > FOLLOW > COMMENT > LIKE, so prefer "Save this for next time you…" over "Like if you agree".
- visual_notes: 4-6 bullets "• " (lighting, 9:16 framing, props, color grade).

VIRALITY
- optimal_post_window: e.g. "Mon-Wed 6-8am or 7-9pm local" (derive from account insights when possible).
- suggested_duration: seconds. Tutorial 25-45s, comparison/transformation 15-25s, storytelling 45-90s.
- thumbnail_concept: ONE visual sentence — Reels cover shows in grid + Explore; design for thumbnail-size legibility.
- engagement_hook: SPECIFIC SAVE-driver ("place the key takeaway as on-screen text in BEAT 3 so the frame is screenshot-able").
- trending_sound: null. (IG API doesn't expose trending sounds.)

Return ONLY a JSON object {ideas:[...]} matching:
{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "source_refs":{...}, "hard_date":string, "saturation_warning":string|null,
  "script":string, "post_title":string, "description":string,
  "hashtags":[string], "cta":string, "visual_notes":string,
  "optimal_post_window":string, "suggested_duration":string,
  "thumbnail_concept":string, "engagement_hook":string,
  "trending_sound":null,
  "platforms":{ "instagram":{ "caption":string, "hashtags":[string] } }
}] }

Your LAST message is this JSON only — no prose, no code fence.`;
}

export async function runVideoIdeasAgent({
  supabase,
  userId,
  integrationId,
  count,
  onStep,
  targetPlatforms,
}: {
  supabase: SupabaseClient;
  userId: string;
  /** Which specific connected account this run is for. */
  integrationId: string;
  count: number;
  onStep?: (s: { count: number; description: string }) => Promise<void> | void;
  /** Platforms to produce caption packages for. The source-integration
   *  platform should be first. Defaults to ["tiktok"] for callers that
   *  haven't been updated yet. */
  targetPlatforms?: string[];
}): Promise<VideoIdeasResult> {
  if (count <= 0) {
    return { ok: true, ideas: [] };
  }

  const integration = await loadIntegration(supabase, userId, integrationId);
  if (!integration) {
    return { ok: false, error: "Integration not found." };
  }
  const SUPPORTED = new Set(["tiktok", "youtube", "instagram"]);
  if (!SUPPORTED.has(integration.provider)) {
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
  const { tools: rawTools, connected } = await buildToolsForIntegrations(
    supabase,
    userId,
    [integration],
  );
  if (!connected.includes(integration.provider)) {
    return {
      ok: false,
      error: `${integration.provider} integration not connected.`,
    };
  }

  // buildToolsForIntegrations unconditionally bundles the chat-agent's
  // CRUD tools for managing video_ideas (list/create/update/etc.) AND
  // video_ideas_list_accounts. The generator must NOT see those —
  // video_ideas_list_accounts in particular lets the model enumerate
  // every account the user has, which prompts it to ask clarifying
  // questions like "which account am I generating for, sungminlee or
  // Hammy?" instead of producing JSON. Strip the entire CRUD set
  // here; the generator only needs research + uploads tools.
  const VIDEO_IDEAS_CRUD_PREFIX = "video_ideas_";
  const tools: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawTools)) {
    if (name.startsWith(VIDEO_IDEAS_CRUD_PREFIX)) continue;
    tools[name] = value;
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

  // Per-account preferences (free-text constraints the creator set).
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
    console.error("[video-ideas-agent] failed to load preferences:", err);
  }

  const today = new Date().toISOString().slice(0, 10);
  // Each integration generates ONLY for its own platform. Cross-
  // posting is now an opt-in downstream behaviour (the Mark-Done modal
  // can still link a single idea to posts on multiple platforms) — at
  // generation time the agent stays focused on the source platform.
  void targetPlatforms;
  let system: string;
  if (integration.provider === "youtube") {
    system = youtubePrompt(count, today, recentReviews, preferences);
  } else if (integration.provider === "instagram") {
    system = instagramPrompt(count, today, recentReviews, preferences);
  } else {
    system = tiktokPrompt(
      count,
      today,
      connected,
      recentReviews,
      preferences,
      [integration.provider],
    );
  }

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
      // Bounded at 15 steps. Beyond that the model is usually doing
      // redundant searches rather than gathering new signal — every
      // run we observed >15 ate Anthropic budget without producing
      // better ideas.
      stopWhen: stepCountIs(15),
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

    let parsed = parseIdeas(result.text);
    let totalTokens = result.usage?.totalTokens ?? 0;

    // Parse-failure retry. Sonnet sometimes ignores the JSON-only
    // instruction and emits a narrative "Here's my analysis…" instead.
    // Rather than throw away the whole run (which already paid for
    // all the tool calls), feed the narrative back and ask for JSON
    // only. No tools, no system context bloat — just reformat what's
    // already in the assistant turn.
    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.warn(
        "[video-ideas-agent] first parse failed, retrying as JSON-only reformat. raw:",
        preview,
      );
      try {
        const retry = await generateText({
          model: getModel(aiProvider, apiKey, userModel),
          system:
            "You convert content-strategy analyses into a strict JSON schema. Your FINAL response is the JSON object only — no prose, no markdown, no code fence. Start with `{` and end with `}`.",
          messages: [
            {
              role: "user",
              content: `Convert the analysis below into exactly ${count} video ideas as a JSON object matching this schema:\n\n${SCHEMA_HINT}\n\nAnalysis to convert:\n\n${result.text}\n\nOutput the JSON only.`,
            },
          ],
        });
        parsed = parseIdeas(retry.text);
        totalTokens += retry.usage?.totalTokens ?? 0;
      } catch (err) {
        console.error("[video-ideas-agent] retry call failed:", err);
      }
    }

    if (!parsed) {
      const preview = result.text.slice(0, 500).replace(/\s+/g, " ");
      console.error(
        "[video-ideas-agent] could not parse ideas after retry. raw:",
        preview,
      );
      return {
        ok: false,
        error: `Agent did not return valid JSON ideas. Preview: ${preview}`,
        tokens: totalTokens || undefined,
      };
    }

    return {
      ok: true,
      ideas: parsed.slice(0, count) as GeneratedIdea[],
      tokens: totalTokens || undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Compact schema hint used by the parse-failure retry. Kept tiny — the
// retry doesn't need the per-platform packaging rules, just enough
// shape that the model produces valid JSON.
const SCHEMA_HINT = `{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "source_refs":{...}, "hard_date":string, "saturation_warning":string|null,
  "script":string, "post_title":string, "description":string,
  "hashtags":[string], "cta":string, "visual_notes":string,
  "optimal_post_window":string, "suggested_duration":string,
  "thumbnail_concept":string, "engagement_hook":string,
  "trending_sound":string|null,
  "platforms":{ /* one of: tiktok={caption,hashtags}, youtube={title,description,hashtags}, instagram={caption,hashtags} */ }
}] }`;

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
  rising: 5, // shorter than trend — rising signal degrades fast
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
