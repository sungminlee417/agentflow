import type { RecentFeedback, RecentReview } from "./types";
import type { AccountContext } from "./context";

// All the per-platform prompt builders + the shared helpers that
// compose them. Extracted from the main agent file so the runner
// (runVideoIdeasAgent) doesn't drown in ~600 lines of prompt text.

const SIMILAR_REVIEWS_TOOL_LINE =
  "- Targeted back-catalogue lookup: video_ideas_find_similar_reviews (format/kind/title_keywords) — use BEFORE finalising any idea you're unsure about, to surface past hits/flops on the same format/topic. The strongest signal you have.";

const FEEDBACK_LOOKUP_TOOL_LINE =
  "- Recent rejections lookup: video_ideas_find_recent_feedback (reason_code/kind) — pull additional thumbs-down history beyond the 15 dumped above. Use when considering anything in adjacent territory to a recent rejection.";

export function describeAvailable(connected: string[]): string {
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
  lines.push(SIMILAR_REVIEWS_TOOL_LINE);
  lines.push(FEEDBACK_LOOKUP_TOOL_LINE);
  lines.push(
    "- Uploaded analytics: list_my_analytics_uploads, get_analytics_upload",
  );
  return lines.join("\n");
}

export function describeYouTubeAvailable(): string {
  return [
    "- YouTube (your channel): youtube_get_my_channel, youtube_list_my_videos",
    "- Per-video deep stats (real watch time + traffic): youtube_get_video_analytics, youtube_get_video_traffic_sources",
    "- Niche/competitor discovery: youtube_search_niche (query, order, published_after_days)",
    "- Audience sentiment: youtube_get_video_comments",
    SIMILAR_REVIEWS_TOOL_LINE,
    FEEDBACK_LOOKUP_TOOL_LINE,
    "- Uploaded analytics CSVs: list_my_analytics_uploads, get_analytics_upload",
  ].join("\n");
}

export function describeInstagramAvailable(connected: string[]): string {
  const lines = [
    "- Instagram (your account): instagram_get_my_account, instagram_list_my_media",
    "- Per-media insights (reach, saved, shares): instagram_get_media_insights",
    "- Account-level insights over time: instagram_get_account_insights",
    "- Audience sentiment: instagram_list_comments",
  ];
  if (connected.includes("apify")) {
    lines.push(
      "- Niche/competitor (Apify): instagram_search_hashtag, instagram_get_profile",
    );
  }
  lines.push(SIMILAR_REVIEWS_TOOL_LINE);
  lines.push(FEEDBACK_LOOKUP_TOOL_LINE);
  lines.push("- Uploaded analytics CSVs: list_my_analytics_uploads, get_analytics_upload");
  return lines.join("\n");
}


function reviewsBlock(reviews: RecentReview[]): string {
  if (reviews.length === 0) return "";
  const lines: string[] = [
    "",
    "Recent post-mortems from videos the creator has actually posted (use these to AVOID repeating past misses and DOUBLE DOWN on patterns that hit):",
  ];
  for (const r of reviews) {
    const ratioStr = r.ratio != null ? `${r.ratio.toFixed(2)}× median` : "unrated";
    const tags = [r.platform, r.kind, r.format ?? "?"]
      .filter((t): t is string => !!t)
      .join(", ");
    lines.push(
      `- "${r.title}" (${tags}): ${r.verdict ?? "?"} · ${ratioStr}`,
    );
    if (r.takeaways) {
      lines.push(`  Learnings: ${r.takeaways}`);
    }
  }
  return lines.join("\n");
}


const REASON_LABELS: Record<string, string> = {
  outdated_trend: "trend was already stale",
  wrong_voice: "doesn't fit the creator's voice",
  flopped_before: "they tried something similar and it flopped",
  platform_wrong: "wrong platform fit (e.g. TikTok trick on YouTube)",
  off_brand: "off-brand topic for this account",
  other: "rejected (other)",
};

function feedbackBlock(items: RecentFeedback[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [
    "",
    "Recent thumbs-down feedback — ideas the creator EXPLICITLY rejected. The next batch MUST avoid repeating these failure modes. If you propose anything in adjacent territory, your rationale must cite which rejection you're deliberately differentiating from:",
  ];
  for (const f of items) {
    const tags = [f.kind, f.format ?? "?"].filter((t): t is string => !!t).join(", ");
    const reason = REASON_LABELS[f.reason_code] ?? f.reason_code;
    lines.push(`- "${f.title}" (${tags}): ${reason}`);
    if (f.hook) lines.push(`  Hook was: "${f.hook}"`);
    if (f.free_text) lines.push(`  Creator note: ${f.free_text}`);
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

export function tiktokPrompt(
  count: number,
  today: string,
  connected: string[],
  recentReviews: RecentReview[] = [],
  recentFeedback: RecentFeedback[] = [],
  preferences: string | null = null,
  targetPlatforms: string[] = ["tiktok"],
): string {
  const hasApify = connected.includes("apify");
  const hasReviews = recentReviews.length > 0;
  const hasFeedback = recentFeedback.length > 0;
  return `You are a TikTok content strategist. Produce UP TO ${count} fresh video ideas as a JSON object. Quality > quantity — if signal is genuinely thin, return fewer ideas with strong evidence rather than ${count} with two fudged.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no "Here are the ideas", no analysis preamble, no markdown headers, no code fence, no clarifying questions, no offers to split the work. The response must START with the literal character \`{\` and END with \`}\`. If the request is ambiguous, pick the most reasonable interpretation from the tool data and proceed — never ask the user. The schema is at the bottom of this message — follow it exactly.

Today is ${today}. Tools:
${describeAvailable(connected)}
${reviewsBlock(recentReviews)}${feedbackBlock(recentFeedback)}${preferencesBlock(preferences)}${platformsBlock(targetPlatforms)}

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
8. For EACH idea you're seriously considering, call video_ideas_find_similar_reviews with that idea's format (and kind if you've decided). Use the returned post-mortems' Takeaways to either (a) refine the idea so it inherits what worked, or (b) drop the idea if past attempts at the same format clearly flopped. SKIP this only when the back catalogue genuinely has no similar work yet.${hasFeedback ? `
9. If you're about to pitch a kind=trend, kind=rising, or kind=competitor idea about a topic similar to anything in the feedback block above, call video_ideas_find_recent_feedback(kind: 'trend' | 'rising' | 'competitor') to confirm whether the creator has already rejected this exact angle. If yes — pick a different angle or downgrade to pattern.` : ""}

EVIDENCE FLOORS — HARD RULES (not aspirational)

Before committing to any non-pattern, non-seasonal idea, check the floor below. If you can't clear it, in order of preference:
  (1) Downgrade to kind="pattern" and ground in the creator's own top performers instead.
  (2) Drop the idea and produce fewer than ${count} total. Honest under-delivery beats fabricated signal.
  (3) Replace with a different idea that DOES clear the floor.

Compute USER_MEDIAN_PLAYS = median of stats.playCount across the top-10 results from tiktok_top_my_videos.

COMPETITOR floor:
- competitor_video.stats.plays >= 0.5 × USER_MEDIAN_PLAYS
- competitor account authorMeta.fans (followers) >= 1000
- Required source_refs: {competitor_handle, competitor_video_url, competitor_video_plays, competitor_followers, user_median_plays}
- Example FAIL: USER_MEDIAN_PLAYS = 80k and the best candidate you found has 11k plays — that's an automatic skip, not a competitor.

TREND floor:
- Sample is from the last 14 days AND sample.stats.plays >= 0.5 × USER_MEDIAN_PLAYS
- Required source_refs: {hashtag, sample_url, sample_plays, sample_create_time}

RISING floor:
- velocity_ratio = (top plays last 3-7d) / (top plays prior 7-14d) >= 1.5
- Required source_refs: {hashtag, recent_window_top_plays, prior_window_top_plays, velocity_ratio}
- Below 1.5 → call it trend (if it clears trend floor) or skip.

HASHTAG-SEARCH FILTERING for competitor selection:
After tiktok_search_hashtag returns N rows:
  (a) Sort by stats.plays descending.
  (b) Compute the median plays across the returned set; the "top half" is anything >= that median.
  (c) ONLY consider videos in the top half as competitor candidates.
  (d) ALSO require stats.plays >= 0.5 × USER_MEDIAN_PLAYS per the competitor floor.
The double filter is intentional: top-half-of-hashtag prevents picking the weakest match in a saturated tag; >=50% USER_MEDIAN prevents the hashtag itself being a low-engagement niche where even the leaders underperform the creator.

HONEST UNDER-DELIVERY:
Default target is ${count} but the caller accepts FEWER. If signal is thin (no Apify, small back-catalogue, weak hashtag results), produce fewer ideas with high confidence rather than ${count} with two of them fudged. Never invent a stat or handle to hit ${count}.

KINDS (balance across these — subject to evidence floors above)
- pattern: extrapolate from a winning format — a NEW song/topic that fits.
- ${hasApify ? `competitor: meets COMPETITOR floor. Something they nailed and the user hasn't.` : `competitor: skip (no Apify).`}
- ${hasApify ? `trend: meets TREND floor. Currently visible, not yet saturated.` : `trend: skip (no Apify).`}
- ${hasApify ? `rising: meets RISING floor. Max 1-2 per refresh.` : `rising: skip (no Apify).`}
- seasonal: calendar-anchored. hard_date in next 60 days (ISO 8601).

RULES
- Ground EVERY idea in a tool result with the source_refs fields required by the EVIDENCE FLOORS above. Missing a required field = the idea is rejected at insert time.
- title: specific + recordable ("Cover Hotel California — acoustic vs classical").
- hook: actual first spoken/shown line.
- format: short ("acoustic vs classical comparison").
- rationale: 1-2 sentences citing specific evidence.${hasReviews ? ` When a post-mortem above applies (same format/hook/topic), the rationale MUST cite it by title + verdict.` : ""}${hasFeedback ? `
- If a recent feedback rejection above mentions a similar format / hook / topic / trend — do NOT regenerate that idea. The creator has already told us why it fails. If proposing a deliberately differentiated take, cite the rejection by title in the rationale and explain the differentiation.` : ""}
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
// YouTube prompt — generates both Shorts AND long-form. The agent
// reads the creator's actual upload history to detect whether they're
// a Shorts channel, long-form channel, or both, and picks per idea.
// Each format has its own algo, audience expectations, script shape,
// title style, and length:
//   • Short: ≤60s, Shorts-feed algo (TikTok-like), retention-driven,
//     hook in 1-2s, vertical 9:16, search hashtags less important.
//   • Long: 3-15+ min, Search/Browse/Suggested algos, CTR-driven
//     (title + thumbnail are everything), chapters/timestamps matter,
//     watch time + AVD matter way more than raw views.
// ─────────────────────────────────────────────────────────────────────
export function youtubePrompt(
  count: number,
  today: string,
  recentReviews: RecentReview[] = [],
  recentFeedback: RecentFeedback[] = [],
  preferences: string | null = null,
): string {
  const hasReviews = recentReviews.length > 0;
  return `You are a YouTube content strategist. Produce UP TO ${count} fresh video ideas as a JSON object. Each idea is EITHER a Short (≤60s) or a long-form video (typically 3-15min) — you decide per idea based on what fits the topic AND the creator's upload mix. Quality > quantity — if signal is genuinely thin, return fewer ideas with strong evidence rather than ${count} with two fudged.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no "Here are the ideas", no analysis preamble, no markdown headers, no code fence, no clarifying questions, no offers to split the work. The response must START with the literal character \`{\` and END with \`}\`. If the request is ambiguous, pick the most reasonable interpretation from the tool data and proceed — never ask the user. The schema is at the bottom of this message — follow it exactly.

Today is ${today}. Tools:
${describeYouTubeAvailable()}
${reviewsBlock(recentReviews)}${feedbackBlock(recentFeedback)}${preferencesBlock(preferences)}

PROCEDURE
1. youtube_get_my_channel — anchor "my channel". Note subs + upload cadence.
2. youtube_list_my_videos (limit 25) — title-keyword patterns + which titles got the most views vs channel median. CRITICAL: tag each recent video as a Short or long-form using its duration (≤60s = Short). Note the rough mix (e.g. "70% Shorts, 30% long-form" or "Shorts-only channel"). This drives the video_format split in your output.
3. For the top 2-3 most-viewed recent videos (mix of Shorts + long-form if available): youtube_get_video_analytics + youtube_get_video_traffic_sources. The traffic-source breakdown (Search vs Browse vs Suggested vs Shorts feed) tells you which formats grow this channel.
4. youtube_search_niche with queries from step-2 title-keywords (order=viewCount, published_after_days=30). Capture: high-view recent videos, common title hooks, non-user channels. 2-3 distinct queries.
5. For the most engaging recent video in step 4, youtube_get_video_comments for audience questions.
6. list_my_analytics_uploads — any YT Studio CSV.
7. For EACH idea you're seriously considering, call video_ideas_find_similar_reviews with that idea's format (and kind if you've decided). Use the returned post-mortems' Takeaways to either refine the idea or drop it if past attempts at the same format clearly flopped. SKIP only when the back catalogue genuinely has no similar work yet.${recentFeedback.length > 0 ? `
8. If you're about to pitch a kind=trend, kind=rising, or kind=competitor idea about a topic similar to anything in the feedback block above, call video_ideas_find_recent_feedback(kind: 'trend' | 'rising' | 'competitor') to confirm whether the creator has already rejected this exact angle. If yes — pick a different angle or downgrade to pattern.` : ""}

FORMAT MIX
Match the creator's actual mix from step 2. Examples:
- Shorts-only channel → all ${count} ideas are video_format="short".
- Long-form-only channel → all video_format="long".
- 60/40 mix → roughly 60% short, 40% long.
Pick the format per idea based on (a) the channel's mix, and (b) what the topic genuinely fits — a deep tutorial belongs in long-form even on a Shorts-heavy channel.

EVIDENCE FLOORS — HARD RULES (not aspirational)

Before committing to any non-pattern, non-seasonal idea, check the floor below. If you can't clear it, in order of preference:
  (1) Downgrade to kind="pattern" and ground in the creator's own top performers instead.
  (2) Drop the idea and produce fewer than ${count} total. Honest under-delivery beats fabricated signal.
  (3) Replace with a different idea that DOES clear the floor.

Compute USER_MEDIAN_VIEWS = median statistics.viewCount across the top-10 most-viewed videos from step 2 (youtube_list_my_videos).

COMPETITOR floor:
- competitor_video.viewCount >= 0.5 × USER_MEDIAN_VIEWS
- competitor channel subscribers (from search result or channel lookup) >= 1000
- Required source_refs: {competitor_channel, competitor_video_url, competitor_video_views, competitor_subscribers, user_median_views}

TREND floor:
- Sample is from the last 14 days AND sample.viewCount >= 0.5 × USER_MEDIAN_VIEWS
- Required source_refs: {query, sample_url, sample_views, sample_published_at}

RISING floor:
- velocity_ratio = (top viewCount last 3-7d) / (top viewCount prior 7-14d) >= 1.5 for the same query
- Required source_refs: {query, recent_window_top_views, prior_window_top_views, velocity_ratio}
- Below 1.5 → call it trend (if it clears trend floor) or skip.

NICHE-SEARCH FILTERING for competitor selection:
After youtube_search_niche returns N rows:
  (a) Sort by viewCount descending.
  (b) Compute the median viewCount across the returned set; the "top half" is anything >= that median.
  (c) ONLY consider videos in the top half as competitor candidates.
  (d) ALSO require viewCount >= 0.5 × USER_MEDIAN_VIEWS per the competitor floor.

HONEST UNDER-DELIVERY:
Default target is ${count} but the caller accepts FEWER. If signal is thin (small back-catalogue, weak niche-search results), produce fewer ideas with high confidence rather than ${count} with two fudged. Never invent a stat, channel, or query to hit ${count}.

KINDS (subject to evidence floors above)
- pattern: source_refs={source_video_id, title}. Extrapolate from a top video.
- competitor: meets COMPETITOR floor. Angle they nailed and user hasn't.
- trend: meets TREND floor. Currently surging in YT Search/Browse.
- rising: meets RISING floor. Max 1-2 per refresh.
- seasonal: hard_date (ISO 8601), next 60 days only.

RULES
- Ground EVERY idea in a tool result with the source_refs fields required by the EVIDENCE FLOORS above. Missing a required field = the idea is rejected at insert time.
- title:
  • Short → search-keyword-optimised + clickable. Front-load the keyword ("Beginner Fingerstyle Riff in 30 Seconds").
  • Long → CTR-optimised — curiosity gap + clear value prop ("I Tried Every Fingerstyle Technique So You Don't Have To"). Title is half the battle on long-form because the algo weighs CTR heavily.
- hook:
  • Short → actual first 1-2s (spoken + on-screen). Retention dies fast.
  • Long → first 30-45s. State the payoff up front then tease the reveal — viewers decide to commit by the 30s mark.
- format: short ("comparison demo", "deep-dive tutorial").
- rationale: 1-2 sentences citing specific evidence.${hasReviews ? ` When a post-mortem above applies, the rationale MUST cite it by title + verdict.` : ""}${recentFeedback.length > 0 ? `
- If a recent feedback rejection above mentions a similar format / hook / topic — do NOT regenerate that idea. Cite the rejection by title in the rationale if proposing a deliberately differentiated take.` : ""}
- saturation_warning: only when you saw the SPECIFIC format saturating; else null.

SCRIPT — pick the structure that matches video_format:

If video_format="short" (timestamps, max 60s):
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

If video_format="long" (timestamps, target 4-10min):
    [0:00-0:45] INTRO / HOOK
      📢 SAY: "<promise the payoff up front + tease the reveal>"
      🎬 ACTION: <on-camera + B-roll teaser>
      📺 ON-SCREEN TEXT: chapter title
    [0:45-2:00] CHAPTER 1 — Context / Setup
      📢 SAY, 🎬 ACTION, 📺 TEXT, ✂️ CUT, 🎵 AUDIO as needed
    [2:00-4:00] CHAPTER 2 — Main demonstration / argument
    [4:00-6:00] CHAPTER 3 — Counter-point or deeper dive
    [6:00-7:30] CHAPTER 4 — Synthesis / payoff fully revealed
    [7:30-8:00] CTA — explicit subscribe + next-video tease
    Include chapter_markers as a separate field: "00:00 Intro / 00:45 Context / 02:00 Demo / 04:00 …". YT Studio reads these as auto-chapters.
HOOK is the first 30-45s — the payoff promise. Total length varies by topic; tutorial deep-dives 8-15min, reviews 6-12min, opinion 4-8min.

CAPTION
- post_title:
  • Short → ≤100 chars. Front-load keyword. "#Shorts" only if natural.
  • Long → ≤70 chars ideal (60-70 reads cleanly in browse + mobile). Curiosity gap + value prop.
- description:
  • Short → 3-5 short paragraphs (search-index payload — repeat spoken keywords). Ends with CTA. No inline hashtags.
  • Long → 5-8 paragraphs. Opens with a 2-sentence summary (the "search snippet"). Includes chapter markers (one per line: "00:00 Title"). Ends with CTA + related-video link placeholders. No inline hashtags.
- hashtags: EXACTLY 3 strings, no leading '#'. YT only surfaces the first 3.
- cta: one explicit ask. Short → "Subscribe for…". Long → "Comment your X — and watch <next vid> next".
- visual_notes: 4-6 bullets "• ". Short → lighting / 9:16 framing / props / B-roll. Long → lighting / 16:9 framing / cutaways / B-roll inserts / chapter art / thumbnail strategy.

VIRALITY
- optimal_post_window: "Tue-Thu 4-6pm local" (derive from analytics; caveat if weak signal). Long-form does better with end-of-week + Saturday morning slots if the analytics show it.
- suggested_duration:
  • Short → seconds, ≤60 ("30-45s").
  • Long → minutes:seconds ("8-10 min" or "6:30").
- thumbnail_concept: ONE visual sentence — the cover frame for Shorts, the clickable thumbnail for long-form (thumbnail is everything on long-form).
- engagement_hook: SPECIFIC comment/replay driver. Long-form also benefits from a mid-video re-engagement moment.
- trending_sound: null. (YT doesn't expose trending sound the way TT does.)

Return ONLY a JSON object {ideas:[...]} matching:
{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "video_format":"short"|"long",
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
export function instagramPrompt(
  count: number,
  today: string,
  connected: string[],
  recentReviews: RecentReview[] = [],
  recentFeedback: RecentFeedback[] = [],
  preferences: string | null = null,
): string {
  const hasApify = connected.includes("apify");
  const hasReviews = recentReviews.length > 0;
  return `You are an Instagram Reels content strategist. Produce UP TO ${count} fresh Reels ideas as a JSON object. Quality > quantity — if signal is genuinely thin, return fewer ideas with strong evidence rather than ${count} with two fudged.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no "Here are the ideas", no analysis preamble, no markdown headers, no code fence, no clarifying questions, no offers to split the work. The response must START with the literal character \`{\` and END with \`}\`. If the request is ambiguous, pick the most reasonable interpretation from the tool data and proceed — never ask the user. The schema is at the bottom of this message — follow it exactly.

Today is ${today}. Tools:
${describeInstagramAvailable(connected)}
${reviewsBlock(recentReviews)}${feedbackBlock(recentFeedback)}${preferencesBlock(preferences)}

PROCEDURE
1. instagram_get_my_account — anchor "my account". Note followers + bio.
2. instagram_list_my_media (limit 25) — caption style, hashtag patterns, which media beat the median on likes/comments.
3. For top 3-5 recent Reels, instagram_get_media_insights. Reach + saves + shares matter MORE than likes; high saves = save-worthy concept.
4. instagram_get_account_insights (days 30) — reach + profile-view trends.
5. For the highest-engagement recent Reel, instagram_list_comments for audience questions.
${hasApify ? `6. Extract the creator's most-recurring 2-3 hashtags from step 2. For each, instagram_search_hashtag (limit 25):
   (a) what's trending in the niche right now;
   (b) 3-5 distinct non-user authors → competitors;
   (c) SATURATION: many recent posts with engagement clearly below niche median → flag in saturation_warning.
7. For 1-2 of those competitor handles, instagram_get_profile (posts_limit 10).
8. For EACH idea you're seriously considering, call video_ideas_find_similar_reviews with that idea's format (and kind if you've decided). Use the returned post-mortems' Takeaways to either refine the idea or drop it if past attempts at the same format clearly flopped. SKIP only when the back catalogue genuinely has no similar work yet.` : `6. For EACH idea you're seriously considering, call video_ideas_find_similar_reviews with that idea's format (and kind if you've decided). Use the returned post-mortems' Takeaways to either refine the idea or drop it if past attempts at the same format clearly flopped. SKIP only when the back catalogue genuinely has no similar work yet.`}${recentFeedback.length > 0 ? `
9. If you're about to pitch a kind=trend, kind=rising, or kind=competitor idea about a topic similar to anything in the feedback block above, call video_ideas_find_recent_feedback(kind: 'trend' | 'rising' | 'competitor') to confirm whether the creator has already rejected this exact angle. If yes — pick a different angle or downgrade to pattern.` : ""}

EVIDENCE FLOORS — HARD RULES (not aspirational)

Before committing to any non-pattern, non-seasonal idea, check the floor below. If you can't clear it, in order of preference:
  (1) Downgrade to kind="pattern" and ground in the creator's own top Reels instead.
  (2) Drop the idea and produce fewer than ${count} total. Honest under-delivery beats fabricated signal.
  (3) Replace with a different idea that DOES clear the floor.

Compute USER_MEDIAN_PLAYS = median play count (or like_count when plays unavailable) across the top-10 best-performing recent Reels from step 2.

COMPETITOR floor:
- competitor_post.likesCount (or playCount when available) >= 0.5 × USER_MEDIAN_PLAYS
- Required source_refs: {competitor_username, competitor_post_url, competitor_post_plays, user_median_plays}

TREND floor:
- Sample is from the last 14 days AND sample plays/likes >= 0.5 × USER_MEDIAN_PLAYS
- Required source_refs: {hashtag, sample_url, sample_plays, sample_timestamp}

RISING floor:
- velocity_ratio = (top plays/likes last 3-7d) / (top plays/likes prior 7-14d) >= 1.5
- Required source_refs: {hashtag, recent_window_top_plays, prior_window_top_plays, velocity_ratio}
- Below 1.5 → call it trend (if it clears trend floor) or skip.

HASHTAG-SEARCH FILTERING for competitor selection (when Apify is connected):
After instagram_search_hashtag returns N rows:
  (a) Sort by likesCount (or playCount if present) descending.
  (b) Compute the median across the returned set; the "top half" is anything >= that median.
  (c) ONLY consider posts in the top half as competitor candidates.
  (d) ALSO require plays/likes >= 0.5 × USER_MEDIAN_PLAYS per the competitor floor.

HONEST UNDER-DELIVERY:
Default target is ${count} but the caller accepts FEWER. If signal is thin (no Apify, small back-catalogue, weak hashtag results), produce fewer ideas with high confidence rather than ${count} with two fudged. Never invent a stat or handle to hit ${count}.

KINDS (subject to evidence floors above)
- pattern: source_refs={source_media_id, permalink}. Extrapolate from a top Reel.
- ${hasApify ? `competitor: meets COMPETITOR floor. Something they nailed and the user hasn't.` : `competitor: SKIP unless a post-mortem above cites one (no Apify connected).`}
- ${hasApify ? `trend: meets TREND floor. Currently visible in the niche.` : `trend: only if user's own insights show a format clearly gaining. Cite the evidence.`}
- ${hasApify ? `rising: meets RISING floor. Max 1-2 per refresh.` : `rising: SKIP unless user's engagement clearly accelerating on a specific format. Max 0-1 per refresh.`}
- seasonal: hard_date (ISO 8601), next 60 days only.

RULES
- Ground EVERY idea in a tool result with the source_refs fields required by the EVIDENCE FLOORS above. Missing a required field = the idea is rejected at insert time.
- title: specific + recordable.
- hook: actual first 1-2s — both spoken AND first on-screen text frame (IG viewers scroll on mute).
- format: short ("save-worthy carousel cover", "tutorial Reel").
- rationale: 1-2 sentences citing specific evidence.${hasReviews ? ` When a post-mortem above applies, cite it by title + verdict.` : ""}${recentFeedback.length > 0 ? `
- If a recent feedback rejection above mentions a similar format / hook / topic — do NOT regenerate that idea. Cite the rejection by title in the rationale if proposing a deliberately differentiated take.` : ""}
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

// ─────────────────────────────────────────────────────────────────────
// Unified multi-account prompt. Replaces the three platform-specific
// prompts above for the new /api/video-ideas/generate flow.
//
// Structure:
//   1. STRICT JSON OUTPUT (same as the per-platform prompts)
//   2. ACCOUNT INVENTORY — list every connected integration with
//      label + platform + integration_id so the model can reference
//      ids when targeting ideas
//   3. CROSS-ACCOUNT TARGETING RULE — aggressive-within-niche +
//      never-shoehorn-across-niche, with examples grounded in the
//      user's actual accounts
//   4. PER-ACCOUNT CONTEXT — reviewsBlock + feedbackBlock +
//      preferencesBlock per account
//   5. UNIFIED TOOL INVENTORY — every provider tool routes via
//      `account` param; research tools take `target_integration_id`
//   6. PROCEDURE — research pass per account, then per-idea
//      review/feedback lookups scoped to the primary target
//   7. EVIDENCE FLOORS — same per-platform thresholds as the per-
//      platform prompts; computed per target account
//   8. KINDS + RULES + SCRIPT TEMPLATES + CAPTION + VIRALITY
//   9. JSON SCHEMA with target_integration_ids + primary_integration_id
//
// The anti-shoehorn rule appears BOTH at the top AND in RULES so it
// survives prompt erosion as the model walks the long structure.
// ─────────────────────────────────────────────────────────────────────

const PROVIDER_LABEL: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
};

function describeUnifiedAvailable(
  accounts: AccountContext[],
  connected: string[],
): string {
  const lines: string[] = [];
  const providers = new Set(accounts.map((a) => a.integration.provider));
  if (providers.has("tiktok")) {
    lines.push(
      "- TikTok per-account tools: tiktok_get_my_profile, tiktok_list_my_videos, tiktok_top_my_videos, tiktok_query_videos (every call takes `account` — pass the integration_id)",
    );
  }
  if (providers.has("youtube")) {
    lines.push(
      "- YouTube per-account tools: youtube_get_my_channel, youtube_list_my_videos, youtube_get_video_analytics, youtube_get_video_traffic_sources, youtube_get_video_comments (each takes `account`)",
    );
    lines.push("- YouTube niche discovery: youtube_search_niche (takes `account` — any YT account suffices)");
  }
  if (providers.has("instagram")) {
    lines.push(
      "- Instagram per-account tools: instagram_get_my_account, instagram_list_my_media, instagram_get_media_insights, instagram_get_account_insights, instagram_list_comments (each takes `account`)",
    );
  }
  if (connected.includes("apify")) {
    if (providers.has("tiktok")) {
      lines.push(
        "- TikTok niche/competitor (Apify): tiktok_search_hashtag, tiktok_search_keyword, tiktok_get_profile",
      );
    }
    if (providers.has("instagram")) {
      lines.push(
        "- Instagram niche/competitor (Apify): instagram_search_hashtag, instagram_get_profile",
      );
    }
  }
  if (connected.includes("transcription")) {
    lines.push(
      "- Transcription: tiktok_transcribe_video — use sparingly to extract a competitor video's exact hook.",
    );
  }
  lines.push(
    "- Targeted back-catalogue lookup: video_ideas_find_similar_reviews — takes `target_integration_id` (the account you're considering an idea FOR), plus format/kind/title_keywords filters. Call BEFORE finalising any idea you're unsure about.",
  );
  lines.push(
    "- Recent rejections lookup: video_ideas_find_recent_feedback — takes `target_integration_id`, plus reason_code/kind filters. Beyond the 15 dumped per-account above.",
  );
  lines.push(
    "- Uploaded analytics CSVs: list_my_analytics_uploads, get_analytics_upload",
  );
  return lines.join("\n");
}

function accountInventoryBlock(accounts: AccountContext[]): string {
  const lines = [
    "ACCOUNT INVENTORY",
    "─────────────────────────",
    "You're generating ideas across these connected accounts. Each idea you produce will target one or more of them via target_integration_ids:",
    "",
  ];
  for (const a of accounts) {
    const platform = PROVIDER_LABEL[a.integration.provider] ?? a.integration.provider;
    lines.push(
      `  [${a.label}] platform=${platform.toLowerCase()}  integration_id=${a.integration.id}`,
    );
  }
  return lines.join("\n");
}

function crossAccountTargetingRule(accounts: AccountContext[]): string {
  // Compose a few concrete examples from the actual labels to keep the
  // rule sticky. If accounts share a label substring ("Sungmin") treat
  // as same-niche siblings; otherwise treat as distinct niches.
  const byLabel = new Map<string, AccountContext[]>();
  for (const a of accounts) {
    // Crude niche-grouping heuristic: the first word of the label.
    const key = a.label.split(/\s+/)[0]?.toLowerCase() ?? "";
    const arr = byLabel.get(key) ?? [];
    arr.push(a);
    byLabel.set(key, arr);
  }
  const sameNicheGroups = [...byLabel.values()].filter((g) => g.length > 1);
  const distinctNicheLabels = [...byLabel.values()]
    .filter((g) => g.length === 1)
    .map((g) => g[0]!.label);

  const exampleLines: string[] = [];
  if (sameNicheGroups.length > 0) {
    const g = sameNicheGroups[0]!;
    exampleLines.push(
      `  • Correctly multi-targeting: an idea that fits ${g.map((a) => a.label).join(" + ")} (same niche, different platforms) — populate target_integration_ids with all of them.`,
    );
  }
  if (distinctNicheLabels.length >= 2) {
    exampleLines.push(
      `  • Correctly single-targeting: an idea for [${distinctNicheLabels[0]}] should NOT also target [${distinctNicheLabels[1]}] — different audiences. Single-target it.`,
    );
  } else if (sameNicheGroups.length > 0 && distinctNicheLabels.length === 1) {
    exampleLines.push(
      `  • Correctly single-targeting: an idea for [${distinctNicheLabels[0]}] should NOT target ${sameNicheGroups[0]!.map((a) => a.label).join(" + ")} — different niche. Single-target it.`,
    );
  }

  return `CROSS-ACCOUNT TARGETING — HARD RULE
─────────────────────────
When two of your accounts share a niche (same person, same topic, different platforms), DEFAULT to multi-targeting any idea that fits the shared niche. The shoot is identical; only the per-platform caption package differs.

When accounts belong to different niches, single-target. NEVER shoehorn an idea onto an account where it doesn't fit just to "use" that account.

For each idea, the rationale must name the target audience(s) and why the topic lands. If multi-targeting, the rationale must mention BOTH audiences explicitly.

${exampleLines.length > 0 ? exampleLines.join("\n") : ""}`;
}

function perAccountContextBlock(accounts: AccountContext[]): string {
  const sections: string[] = ["PER-ACCOUNT CONTEXT", "─────────────────────────"];
  for (const a of accounts) {
    const platform = PROVIDER_LABEL[a.integration.provider] ?? a.integration.provider;
    sections.push(
      "",
      `━━━ [${a.label}] (id=${a.integration.id}, platform=${platform.toLowerCase()}) ━━━`,
    );
    const reviews = reviewsBlock(a.recentReviews);
    const feedback = feedbackBlock(a.recentFeedback);
    const prefs = preferencesBlock(a.preferences);
    if (!reviews && !feedback && !prefs) {
      sections.push(
        "(No reviewed posts, rejected ideas, or per-account preferences yet — generate based on tool research.)",
      );
    } else {
      if (reviews) sections.push(reviews);
      if (feedback) sections.push(feedback);
      if (prefs) sections.push(prefs);
    }
  }
  return sections.join("\n");
}

function unifiedProcedureBlock(
  accounts: AccountContext[],
  connected: string[],
): string {
  const lines: string[] = [
    "PROCEDURE",
    "─────────────────────────",
    "1. For EACH account in the inventory, run the platform-appropriate research pass. Use the `account` parameter on every provider tool to scope to that integration_id:",
    "",
  ];
  for (const a of accounts) {
    const provider = a.integration.provider;
    if (provider === "tiktok") {
      lines.push(
        `   • [${a.label}] tiktok_top_my_videos (top_n 10, from_history 100) → derive USER_MEDIAN_PLAYS_${a.label}. Then tiktok_list_my_videos (max_count 20) for current voice. ${connected.includes("apify") ? `Then tiktok_search_hashtag on the top 2 hashtags for niche/competitor/trend/rising signal.` : `(No Apify — skip competitor/trend/rising for this account.)`}`,
      );
    } else if (provider === "youtube") {
      lines.push(
        `   • [${a.label}] youtube_get_my_channel + youtube_list_my_videos (limit 20) → derive USER_MEDIAN_VIEWS_${a.label} + detect Shorts vs long-form mix. Then youtube_search_niche on 1-2 recent topics for competitor/trend signal.`,
      );
    } else if (provider === "instagram") {
      lines.push(
        `   • [${a.label}] instagram_get_my_account + instagram_list_my_media (limit 20) + instagram_get_media_insights on top 2-3 → derive USER_MEDIAN_PLAYS_${a.label}. ${connected.includes("apify") ? `Then instagram_search_hashtag on the niche tag for competitor/trend signal.` : `(No Apify — skip competitor/trend/rising for this account.)`}`,
      );
    }
  }
  lines.push("");
  lines.push(
    "2. For EACH candidate idea, decide its target_integration_ids (1+) and primary_integration_id (must be in the array).",
  );
  lines.push(
    "3. Call video_ideas_find_similar_reviews with target_integration_id = your primary target. Use the returned post-mortems to refine or drop the idea.",
  );
  lines.push(
    "4. If kind ∈ {trend, rising, competitor}, also call video_ideas_find_recent_feedback with the same target_integration_id to verify the creator hasn't already rejected this angle.",
  );
  return lines.join("\n");
}

const UNIFIED_EVIDENCE_FLOORS = `EVIDENCE FLOORS — HARD RULES (computed per target account using THAT account's USER_MEDIAN)
─────────────────────────

Before committing to any non-pattern, non-seasonal idea, check the floor for the platform of the PRIMARY target. If you can't clear it, in order of preference:
  (1) Downgrade to kind="pattern" and ground in that account's own top performers.
  (2) Drop the idea — honest under-delivery beats fabricated signal.
  (3) Replace with a different idea that DOES clear the floor.

COMPETITOR floor (TT/IG):
- competitor_video plays >= 0.5 × USER_MEDIAN_PLAYS for that target account
- competitor account followers >= 1000
- Required source_refs: {competitor_handle, competitor_video_url, competitor_video_plays, competitor_followers, user_median_plays, target_integration_id}

COMPETITOR floor (YT):
- competitor video views >= 0.5 × USER_MEDIAN_VIEWS for that target account
- competitor channel subscribers >= 1000
- Required source_refs: {competitor_handle, competitor_video_url, competitor_video_views, competitor_subscribers, user_median_views, target_integration_id}

TREND floor:
- Sample is from last 14 days AND sample plays/views >= 0.5 × USER_MEDIAN for that target
- Required source_refs: {hashtag, sample_url, sample_plays|views, sample_create_time, target_integration_id}

RISING floor:
- velocity_ratio = (top plays last 3-7d) / (top plays prior 7-14d) >= 1.5
- Required source_refs: {hashtag, recent_window_top_plays, prior_window_top_plays, velocity_ratio, target_integration_id}
- Below 1.5 → call it trend or skip.

HASHTAG-SEARCH FILTERING (Apify TT + IG):
After search returns N rows: sort by plays desc, only consider the top half AND require plays >= 0.5 × USER_MEDIAN for the target account.`;

const UNIFIED_SCRIPT_TEMPLATES = `SCRIPT TEMPLATES — pick the template matching the PRIMARY target's platform + video_format

TikTok / IG Reels / YouTube Shorts (short, ≤60s):
    [0:00-0:03] HOOK   📢 SAY · 🎬 ACTION · 📺 ON-SCREEN TEXT · 🎵 AUDIO
    [0:03-0:10] BEAT 1 — Setup
    [0:10-0:25] BEAT 2 — Payoff/Demo (✂️ CUT)
    [0:25-0:35] BEAT 3 — Twist/Comparison
    [0:35-0:40] CTA
HOOK ≤3s, CTA ≤5s, total ≤60s.

YouTube long-form (3-15 min):
    [0:00-0:30] HOOK — promise + stakes; on-screen title card
    [0:30-1:00] CONTEXT — why this matters; chapter 1 transition
    [Chapters] each chapter is a discrete beat with: chapter title, on-screen text overlay, B-roll cues, restated promise
    [Outro 0:30] recap + soft CTA + end-screen CTA
Pacing 60-90 words spoken per minute (slower for tutorial).`;

export function unifiedPrompt(args: {
  totalCount: number;
  today: string;
  accounts: AccountContext[];
  connected: string[];
}): string {
  const { totalCount, today, accounts, connected } = args;
  if (accounts.length === 0) {
    throw new Error("unifiedPrompt: at least one account required");
  }
  return `You are a multi-channel content strategist working across ${accounts.length} creator account${accounts.length === 1 ? "" : "s"}. Produce UP TO ${totalCount} fresh video ideas across the accounts below. Each idea targets one or more accounts. Quality > quantity — if signal is thin, return fewer ideas with strong evidence rather than ${totalCount} with fudged ones.

OUTPUT FORMAT — STRICT: Your FINAL response is the JSON object only. No "Perfect", no preamble, no markdown headers, no code fence, no clarifying questions. The response must START with the literal character \`{\` and END with \`}\`. If ambiguous, pick the most reasonable interpretation from the tool data — never ask the user.

Today is ${today}.

${accountInventoryBlock(accounts)}

${crossAccountTargetingRule(accounts)}

${perAccountContextBlock(accounts)}

UNIFIED TOOL INVENTORY
─────────────────────────
${describeUnifiedAvailable(accounts, connected)}

${unifiedProcedureBlock(accounts, connected)}

${UNIFIED_EVIDENCE_FLOORS}

KINDS (balance across these — subject to evidence floors above)
- pattern: extrapolate from a winning format — a NEW song/topic that fits.
- competitor: meets COMPETITOR floor. Something a peer nailed and this account hasn't.
- trend: meets TREND floor. Currently visible, not yet saturated.
- rising: meets RISING floor. Max 1-2 per refresh.
- seasonal: calendar-anchored. hard_date in next 60 days (ISO 8601).

RULES
- Ground EVERY idea in a tool result with the source_refs fields required by the EVIDENCE FLOORS above. Missing a required field = the idea is rejected at insert time.
- target_integration_ids: array of >=1 integration_ids from the ACCOUNT INVENTORY. Aggressive-within-niche multi-targeting is encouraged; cross-niche shoehorning is forbidden (see CROSS-ACCOUNT TARGETING above).
- primary_integration_id: must be a member of target_integration_ids. Determines the default platform-pack and the back-compat video_ideas.integration_id mirror.
- title: specific + recordable.
- hook: actual first spoken/shown line.
- format: short ("acoustic vs classical comparison").
- rationale: 1-2 sentences citing specific evidence. If multi-targeting, name BOTH target audiences and why the topic lands for each. If a recent post-mortem above applies to the primary target, cite it by title + verdict.
- saturation_warning: short string only when you saw the SPECIFIC format with saturation signals; else null.
- video_format: set to "short" or "long" ONLY when a YouTube account is in target_integration_ids; otherwise null.

${UNIFIED_SCRIPT_TEMPLATES}

CAPTION FIELDS (base — shared across platforms)
- post_title: ≤100 chars, attention-grabbing.
- description: 2-3 short paragraphs ending with CTA. No inline hashtags.
- hashtags: 5-7 strings, no leading '#'. Base set; per-platform packs may override.
- cta: one explicit ask.
- visual_notes: 4-6 "• " bullets (lighting, framing, props, B-roll).

VIRALITY
- optimal_post_window: derive from top performers' create_time patterns of the primary target.
- suggested_duration: seconds, e.g. "18-25s".
- thumbnail_concept: ONE visual sentence.
- engagement_hook: SPECIFIC comment-driver, distinct from opening hook.
- trending_sound: name + sound id/URL when found; else null. Never invent.

PER-PLATFORM PACKAGING
─────────────────────────
For each idea, populate idea.platforms with a sub-pack for EVERY distinct PLATFORM in target_integration_ids' providers. Two TikTok accounts → one tiktok pack (same caption serves both). Targets spanning TT+YT+IG → all three packs.

  • TikTok pack: caption ≤150 chars + 5-7 hashtags (no leading #). Conversational, end with a soft question.
  • YouTube pack: title ≤100 chars (search-optimised, keyword front-loaded) + description 3-5 paragraphs + 3-5 hashtags. Don't lead the title with a hashtag.
  • Instagram pack: caption 150-400 chars typical (2200 max), hook line survives the ~125-char truncation cutoff. 3-8 niche-focused hashtags.

JSON SCHEMA
─────────────────────────
Return ONLY a JSON object {ideas:[...]} matching:
{ "ideas":[{
  "title":string, "hook":string, "format":string, "rationale":string,
  "kind":"pattern"|"trend"|"rising"|"competitor"|"seasonal",
  "target_integration_ids":[uuid, ...],   // >=1
  "primary_integration_id":uuid,           // must be in target_integration_ids
  "source_refs":{...}, "hard_date":string, "saturation_warning":string|null,
  "script":string, "post_title":string, "description":string,
  "hashtags":[string], "cta":string, "visual_notes":string,
  "optimal_post_window":string, "suggested_duration":string,
  "thumbnail_concept":string, "engagement_hook":string,
  "trending_sound":string|null,
  "video_format":"short"|"long"|null,
  "platforms":{
    "tiktok":{ "caption":string, "hashtags":[string] }?,
    "youtube":{ "title":string, "description":string, "hashtags":[string] }?,
    "instagram":{ "caption":string, "hashtags":[string] }?
  }
}] }

Your LAST message is this JSON only — no prose, no code fence.`;
}
