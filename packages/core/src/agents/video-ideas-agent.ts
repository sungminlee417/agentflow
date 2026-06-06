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

Today is ${today}.

Available tools:
${describeAvailable(connected)}
${reviewsBlock(recentReviews)}${preferencesBlock(preferences)}${platformsBlock(targetPlatforms)}

Required procedure:
1. tiktok_top_my_videos (top_n 10, from_history 100) — these are the creator's lifetime best by engagement rate (likes ÷ views), pulled across their last ~100 uploads. This tells you what their audience actually rewards, not just what they posted recently.
2. tiktok_list_my_videos (max_count 20) — most recent 20 uploads. This tells you the creator's CURRENT voice / pacing / topic focus, even if recent videos haven't all popped. Match scripts to this voice.
3. Cross-reference: the patterns in the top 10 are what works for this audience; the recent 20 is how this creator currently sounds. Your ideas should hit the top-10 patterns delivered in the recent-20 voice.
4. Extract the creator's most-used hashtags from the top performers.
4b. TIMING SIGNAL: from the top 10 performers' create_time values, note the day-of-week + hour patterns (convert from unix seconds to UTC, then state the assumption that the creator's audience is roughly in their own timezone). This becomes the basis for each idea's optimal_post_window.
4c. AUDIO/SOUND: scan the top performers for music_meta or recurring audio. If the creator has a winning sound pattern (original audio vs trending), capture it.
${hasApify ? `5. For each of the top 2-3 hashtags, tiktok_search_hashtag (limit 25). From the results:
   (a) Note what's trending right now (high recent engagement)
   (b) **Velocity check** — group videos by week using create_time. If the past 3-7 days' top performers have notably HIGHER engagement (likes/views) than the prior 7-14 days, that hashtag/topic is ACCELERATING. Call this out — it's the seed for rising-kind ideas.
   (c) **Saturation check** — if a hashtag has 15+ recent videos with engagement clearly BELOW the niche median (e.g. half), it's oversaturated. Don't recommend pattern ideas in that exact format without a strong twist — flag it in saturation_warning.
   (d) Collect 3-5 distinct authors (NOT the user) who consistently post in this niche — these are auto-discovered competitors.
6. For 1-2 of those competitor handles, tiktok_get_profile (videos_limit 10) to surface songs/formats they covered well that the user hasn't.
7. list_my_analytics_uploads — read any CSV uploads for deeper retention/traffic-source signal.` : `5. Skip Apify-backed competitor + trend + rising discovery (not configured). Lean harder on pattern + seasonal kinds.
6. list_my_analytics_uploads — read any CSV uploads for deeper retention/traffic-source signal.`}

Now produce exactly ${count} ideas, balanced across these kinds based on what's available:
- "pattern": extrapolated from the user's own winning format. Suggest a specific NEW song / topic / target they haven't covered that fits the pattern.
- ${hasApify ? `"competitor": cite the competitor handle in source_refs ({competitor_handle: "...", competitor_video_url: "..."}). The idea must be something they nailed that the user hasn't.` : `"competitor": skip — no competitor data available without Apify.`}
- ${hasApify ? `"trend": cite the hashtag and/or trending sound in source_refs. The trend is CURRENTLY visible in the niche — already in motion but not yet saturated.` : `"trend": skip — no trend data available without Apify.`}
- ${hasApify ? `"rising": engagement velocity is ACCELERATING in the last 3-7 days but the trend hasn't peaked. Cite specific evidence in source_refs ({hashtag: "...", velocity_note: "engagement up ~Nx vs prior week", sample_url: "..."}) — never label something "rising" without that velocity comparison from your tool data. These are the "be early to the curve" plays. Keep these to 1-2 per refresh max.` : `"rising": skip — no velocity data available without Apify.`}
- "seasonal": calendar-anchored — a holiday, anniversary of a famous piece, a known meme day. Include hard_date (ISO 8601) for when the idea should ship by. Today is ${today}; only suggest hard_dates in the next 60 days.

Critical:
- Every idea MUST be grounded in something you actually saw in a tool result. No invented stats, no invented competitor handles, no invented trending hashtags.
- Each title must be specific and recordable — "Cover Hotel California — acoustic vs classical" not "do another comparison video".
- hook must be the actual first spoken/shown line.
- format should be short ("acoustic vs classical comparison", "solo performance with text overlay").
- rationale: 1-2 sentences citing the specific evidence ("your top 3 videos all use this format; song X has high search volume in #fingerstyle this week").${hasReviews ? `
  WHEN A PRIOR POST-MORTEM ABOVE IS RELEVANT (same format, same hook style, similar topic), the rationale MUST cite it by title and verdict. Examples: "Extends your 'Hotel California — acoustic vs classical' hit (2.1× median)." Or: "Replaces the underperforming 'Bach Prelude solo' format (0.43×) — comparison hook instead." Ignoring an applicable post-mortem when one exists is the worst failure mode here.` : ""}
- saturation_warning (NULL or short string): only set this when you saw the SPECIFIC format or topic showing saturation signals (lots of similar recent videos with below-niche-median engagement). Be specific — e.g. "Acoustic-vs-classical comparisons of Bach pieces have 30+ posts in #fingerstyle this month with median engagement dropping ~40% — twist needed to stand out (suggested in the script)." Leave null when there's no saturation concern.${hasReviews ? `
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

Virality fields — fill ALL of these for every idea (these are the levers that actually move reach):

- optimal_post_window: human-readable day-of-week + hour range to post for best reach, derived from step 4b. Format: "Tue-Thu 7-9pm local time". If you don't have strong signal from the top performers, state your best guess + the caveat: "Mon-Wed 6-9pm local time (limited signal from top videos)".
- suggested_duration: recommended length window in seconds for THIS idea's format. Comparison/demo formats often work at 18-25s; tutorial deep-dives at 35-50s; teaser hooks at 7-12s. Match it to what the top performers in the creator's catalog use for the same format.
- thumbnail_concept: ONE sentence describing what the first frame (= the cover shown in the For You feed) should look like. Be visual: "Tight close-up of two guitar headstocks side by side, big white text 'WHICH SOUNDS BETTER?' across the top." This is as important as the hook for getting tapped in feed.
- engagement_hook: a SPECIFIC element designed to drive COMMENTS (distinct from the opening hook which is about stopping the scroll). E.g. "Hold the final note 2s longer on one option than the other so viewers have to comment which one they liked more." Or "Phrase the on-screen text as a question viewers can answer in one word."
- trending_sound: if a specific TikTok sound (original audio creator + song name, ideally with the sound id or URL) is currently trending in the niche AND fits this idea, name it explicitly: "@username's 'Song Title' (sound id: 1234...) — viral in #fingerstyle the past 2 weeks." If none is appropriate, set this to null. NEVER invent a sound that didn't come from a tool result.

Return ONLY a JSON object {ideas: [...]} matching the schema below. No commentary, no markdown, no code fence.

JSON schema for the final response:
{
  "ideas": [
    {
      "title": string,
      "hook": string,
      "format": string,
      "rationale": string,
      "kind": "pattern" | "trend" | "rising" | "competitor" | "seasonal",
      "source_refs": { ... },        // free-form object, e.g. { "competitor_handle": "@x", "hashtag": "#y", "velocity_note": "...", "url": "https://..." }
      "hard_date": string,           // only for seasonal, ISO 8601 date
      "saturation_warning": string | null,  // null when no signal of saturation
      "script": string,              // beat-by-beat, with timestamps
      "post_title": string,
      "description": string,
      "hashtags": [string, ...],     // no leading '#'
      "cta": string,
      "visual_notes": string,
      "optimal_post_window": string, // "Tue-Thu 7-9pm local"
      "suggested_duration": string,  // "18-25s"
      "thumbnail_concept": string,
      "engagement_hook": string,
      "trending_sound": string | null,
      "platforms": {                  // per-platform caption packaging; include ONLY the platforms listed in the PER-PLATFORM PACKAGING block above
        "tiktok":    { "caption": string, "hashtags": [string, ...] },
        "youtube":   { "title": string, "description": string, "hashtags": [string, ...] },
        "instagram": { "caption": string, "hashtags": [string, ...] }
      }
    }
  ]
}

Your VERY LAST message must be this JSON and nothing else. Do not say "Here are the ideas:" or wrap in \`\`\`.`;
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

Today is ${today}.

Available tools:
${describeYouTubeAvailable()}
${reviewsBlock(recentReviews)}${preferencesBlock(preferences)}

Required procedure:
1. youtube_get_my_channel — anchor what "my channel" is. Note subscriber count + recent upload cadence.
2. youtube_list_my_videos (limit 25) — recent uploads. Note title-keyword patterns and which titles got the most views relative to channel median.
3. For the top 2-3 most-viewed recent videos, youtube_get_video_analytics + youtube_get_video_traffic_sources. The traffic-source breakdown is the high-leverage signal — "YouTube Search" vs "Browse Features" vs "Suggested Videos" tells you whether the channel grows on discovery or recommendations.
4. youtube_search_niche with the channel's core topic (queries derived from the recurring title-keywords in step 2). Use order=viewCount + published_after_days=30. Look for: (a) high-view recent Shorts in the niche, (b) common title hooks, (c) channels other than the user's. Run 2-3 distinct queries.
5. For the most engaging recent video in step 4, youtube_get_video_comments to surface what the audience is asking for in the niche.
6. list_my_analytics_uploads — read any uploaded YT Studio CSV for deeper retention/CTR signal.

Now produce exactly ${count} ideas, balanced across:
- "pattern": extrapolates from one of the user's own top videos. Cite the source video id + title in source_refs ({source_video_id: "...", title: "..."}).
- "competitor": cite a competitor video discovered in step 4 in source_refs ({competitor_channel: "...", competitor_video_url: "https://..."}). The angle must be something they nailed that the user hasn't.
- "trend": cite the niche query + a high-view example in source_refs ({query: "...", example_url: "..."}). Trend means CURRENTLY surging in YouTube Search / Browse for this niche.
- "rising": same as trend but with an explicit velocity claim — videos posted in the last 3-7 days outperforming the prior 7-14 days for the same query. Keep to 1-2 per refresh max.
- "seasonal": calendar-anchored. Include hard_date (ISO 8601). Today is ${today}; only suggest hard_dates in the next 60 days.

Critical:
- Every idea MUST be grounded in something you actually saw in a tool result. No invented stats, no invented competitor channels, no made-up search terms.
- Each title must be search-keyword-optimised AND clickable. Front-load the keyword phrase (e.g. "Beginner Fingerstyle Riff in 30 Seconds" not "30 second clip!").
- hook must be the actual first 1-2 seconds (spoken line + on-screen text). YT Shorts retention dies in seconds.
- format should be short ("comparison demo", "before/after tutorial", "speed-run riff").
- rationale: 1-2 sentences citing specific evidence ("your last 3 Shorts that broke 10k views all front-load 'beginner'; queries for 'beginner fingerstyle riff' have 30+ Shorts >50k views in the last week").${hasReviews ? `
  WHEN A PRIOR POST-MORTEM ABOVE IS RELEVANT, the rationale MUST cite it by title and verdict.` : ""}
- saturation_warning (NULL or short string): set only if you saw the SPECIFIC format showing saturation signals in the niche.${hasReviews ? `
- The post-mortems above are GROUND TRUTH from videos the creator has already shipped. Steer toward formats/titles that hit, away from ones that underperformed.` : ""}

Upload-ready content for EVERY idea:

- script: a SHOOT-READY breakdown, labeled time-stamped blocks, one per line. Required blocks in order:

    [0:00-0:02] HOOK
      📢 SAY: "<the exact words to speak>"
      🎬 ACTION: <on-camera action>
      📺 ON-SCREEN TEXT: "<words on screen>"
      🎵 AUDIO: <music cue / original audio / ambient>

    [0:02-0:15] BEAT 1 — Setup
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      📺 ON-SCREEN TEXT: "<...>"

    [0:15-0:35] BEAT 2 — Payoff / Demo
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      ✂️ CUT: <transition>

    [0:35-0:50] BEAT 3 — Twist / Comparison
      📢 SAY: "<...>"
      🎬 ACTION: <...>

    [0:50-1:00] CTA
      📢 SAY: "<explicit ask>"
      📺 ON-SCREEN TEXT: "<short ask, e.g. 'SUBSCRIBE' or 'COMMENT YOUR PICK'>"

    Shorts MAX 60s — keep total under :60. HOOK ≤2s, CTA ≤8s. Match the creator's voice from youtube_list_my_videos.

- post_title: the YouTube Shorts title (≤100 chars). Front-load the keyword phrase. Include #Shorts somewhere if it fits naturally but don't force it.
- description: 3-5 short paragraphs. This text is search-index payload — repeat the spoken keyword phrases. End with the CTA. Include line breaks between paragraphs. Hashtags do NOT go here.
- hashtags: 3 strings WITHOUT the leading '#'. Only 3 — YouTube surfaces only the first 3 above the video player. Pick the most specific niche tags.
- cta: one explicit ask ("Subscribe for more 30-second riffs every Friday").
- visual_notes: 4-6 short bullets — lighting, framing (9:16 vertical for Shorts), props, B-roll inserts, color grade. "• " prefix per bullet.

Virality fields — fill ALL for every idea:

- optimal_post_window: human-readable day-of-week + hour range, derived from analytics where possible. YT's discovery curves favor weekdays late afternoon/early evening US time for most channels. Format: "Tue-Thu 4-6pm local time". State your caveat if signal is weak.
- suggested_duration: target length in seconds, MAX 60. Comparison/tutorial Shorts often work at 30-45s; high-energy hooks at 12-20s. Match the top-viewed Shorts in the creator's catalog for the same format.
- thumbnail_concept: ONE sentence describing the cover frame. The cover is critical for Shorts browse-feed taps. Be visual: "Split-screen two guitar headstocks with bold yellow text 'WHICH SOUNDS BETTER?' across the top half."
- engagement_hook: a SPECIFIC element designed to drive COMMENTS or REPLAYS (drives algo). E.g. "End on a held note 2s longer than the other side so viewers comment which they preferred."
- trending_sound: leave as null for YouTube — YT Shorts uses its own audio library, not algorithmically-trending sounds the way TikTok does. Set this to null.

Return ONLY a JSON object {ideas: [...]} matching the schema below.

JSON schema for the final response:
{
  "ideas": [
    {
      "title": string,
      "hook": string,
      "format": string,
      "rationale": string,
      "kind": "pattern" | "trend" | "rising" | "competitor" | "seasonal",
      "source_refs": { ... },
      "hard_date": string,
      "saturation_warning": string | null,
      "script": string,
      "post_title": string,
      "description": string,
      "hashtags": [string, string, string],
      "cta": string,
      "visual_notes": string,
      "optimal_post_window": string,
      "suggested_duration": string,
      "thumbnail_concept": string,
      "engagement_hook": string,
      "trending_sound": null,
      "platforms": {
        "youtube": { "title": string, "description": string, "hashtags": [string, string, string] }
      }
    }
  ]
}

Your VERY LAST message must be this JSON and nothing else. Do not say "Here are the ideas:" or wrap in \`\`\`.`;
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

Today is ${today}.

Available tools:
${describeInstagramAvailable()}
${reviewsBlock(recentReviews)}${preferencesBlock(preferences)}

Required procedure:
1. instagram_get_my_account — anchor what "my account" is. Note follower count, bio.
2. instagram_list_my_media (limit 25) — recent posts/Reels. Note caption style, hashtag patterns, and which media got the most likes/comments relative to median.
3. For the top 3-5 best-performing recent Reels, instagram_get_media_insights. Reach + saves + shares matter MORE than likes on IG. A Reel with high saves indicates a save-worthy concept.
4. instagram_get_account_insights (days 30) — recent reach + profile-view trends. Are saves trending up or down?
5. For the highest-engagement recent Reel, instagram_list_comments to surface what the audience is asking for.

Now produce exactly ${count} ideas, balanced across:
- "pattern": extrapolates from one of the user's own top Reels. Cite the source media id + permalink in source_refs ({source_media_id: "...", permalink: "..."}).
- "competitor": SKIP unless the recent post-mortems already cite a competitor. IG's API doesn't expose niche search without third-party tools. Lean harder on pattern + seasonal.
- "trend": only if a clear pattern in the user's own recent insights shows a format gaining (e.g. carousel posts trending up vs single Reels). Cite the evidence.
- "rising": SKIP unless the user's own engagement is clearly accelerating on a specific format. Keep to 0-1 per refresh.
- "seasonal": calendar-anchored. Include hard_date (ISO 8601). Today is ${today}; only suggest hard_dates in the next 60 days.

Critical:
- Every idea MUST be grounded in something you actually saw in a tool result. No invented stats, no invented competitors.
- Each title must be specific and recordable.
- hook must be the actual first 1-2s — both spoken AND the first on-screen text frame (IG users scroll on muted often, so on-screen text carries the hook).
- format should be short ("save-worthy carousel cover", "before/after Reel with text overlay", "tutorial Reel").
- rationale: 1-2 sentences citing specific evidence ("your top 3 Reels by saves all use the 'X mistake → fix' format; your 30d reach is up 15% on that format").${hasReviews ? `
  WHEN A PRIOR POST-MORTEM ABOVE IS RELEVANT, cite it by title and verdict.` : ""}
- saturation_warning (NULL or short string): only set if you saw clear saturation signals in the user's own recent insights.${hasReviews ? `
- Post-mortems above are GROUND TRUTH. Steer toward formats that hit, away from those that underperformed.` : ""}

Upload-ready content for EVERY idea:

- script: SHOOT-READY breakdown, labeled time-stamped blocks. Required blocks in order:

    [0:00-0:02] HOOK
      📢 SAY: "<exact words>"
      🎬 ACTION: <on-camera action>
      📺 ON-SCREEN TEXT: "<words on screen — IG viewers often scroll on mute>"
      🎵 AUDIO: <music cue>

    [0:02-0:10] BEAT 1 — Setup
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      📺 ON-SCREEN TEXT: "<...>"

    [0:10-0:25] BEAT 2 — Payoff
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      ✂️ CUT: <transition>

    [0:25-0:35] BEAT 3 — Save-worthy moment
      📢 SAY: "<...>"
      🎬 ACTION: <...>
      📺 ON-SCREEN TEXT: "<one frame that summarises the takeaway — designed to be screenshot/saved>"

    [0:35-0:40] CTA
      📢 SAY: "<explicit ask>"
      📺 ON-SCREEN TEXT: "<'SAVE FOR LATER' or 'COMMENT YOUR PICK'>"

    Reels max 90s for best reach; sweet spot 25-45s. HOOK ≤2s, CTA ≤5s. Match the creator's voice from instagram_list_my_media.

- post_title: leave as the same value as the caption opener (≤125 chars) — IG doesn't have a separate title field. This first line is what survives truncation in the feed.
- description: storytelling-style caption, 2-4 short paragraphs (line breaks between). Total under 500 chars unless the format genuinely benefits from longer. End with the CTA. Do NOT include hashtags here; they go in the hashtags field.
- hashtags: 3-8 strings WITHOUT the leading '#'. Niche-focused — avoid generic mass tags (#love, #instagood) which IG's algo penalises. Mix specific niche tags with 1-2 trend tags if any are visible from your tool calls.
- cta: one explicit ask. SAVE > FOLLOW > COMMENT > LIKE in algo weight on IG, so prefer "Save this for next time you…" over "Like if you agree".
- visual_notes: 4-6 short bullets — lighting, framing (9:16 vertical), props, color grade. "• " prefix per bullet.

Virality fields — fill ALL for every idea:

- optimal_post_window: derived from instagram_get_account_insights when possible. IG generally favors weekday morning + evening windows for most niches. Format: "Mon-Wed 6-8am or 7-9pm local time".
- suggested_duration: target length in seconds. Save-worthy tutorial Reels often work at 25-45s; comparison/transformation at 15-25s; storytelling at 45-90s.
- thumbnail_concept: ONE sentence describing the cover. Reels cover shows in the grid + Explore — design it to read clearly at thumbnail size. Be visual.
- engagement_hook: a SPECIFIC element designed to drive SAVES (highest algo weight). E.g. "Place the key takeaway as on-screen text in BEAT 3 so the frame is screenshot-able."
- trending_sound: leave as null. IG's API doesn't expose trending sounds; the creator picks from in-app library. Set null.

Return ONLY a JSON object {ideas: [...]} matching the schema below.

JSON schema for the final response:
{
  "ideas": [
    {
      "title": string,
      "hook": string,
      "format": string,
      "rationale": string,
      "kind": "pattern" | "trend" | "rising" | "competitor" | "seasonal",
      "source_refs": { ... },
      "hard_date": string,
      "saturation_warning": string | null,
      "script": string,
      "post_title": string,
      "description": string,
      "hashtags": [string, ...],
      "cta": string,
      "visual_notes": string,
      "optimal_post_window": string,
      "suggested_duration": string,
      "thumbnail_concept": string,
      "engagement_hook": string,
      "trending_sound": null,
      "platforms": {
        "instagram": { "caption": string, "hashtags": [string, ...] }
      }
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
  const { tools, connected } = await buildToolsForIntegrations(
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
