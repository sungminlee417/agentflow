// Shared types for the video-ideas generator agent. Extracted from
// the main agent file so the prompt builders + parser modules can
// import them without circular imports through the agent itself.

export type VideoIdeaKind =
  | "pattern"
  | "trend"
  | "rising"
  | "competitor"
  | "seasonal";

export type PlatformPack = {
  tiktok?: { caption: string; hashtags: string[] };
  youtube?: { title: string; description: string; hashtags: string[] };
  instagram?: { caption: string; hashtags: string[] };
};

export type GeneratedIdea = {
  title: string;
  hook?: string;
  format?: string;
  rationale?: string;
  kind: VideoIdeaKind;
  /** Which connected accounts this idea targets. >=1 required.
   *  Aggressive within-niche multi-targeting is encouraged; cross-niche
   *  shoehorning is forbidden by the prompt. */
  target_integration_ids: string[];
  /** Which target is the "primary" — drives video_ideas.integration_id
   *  for back-compat and chooses the default platform-pack on cards.
   *  Must be a member of target_integration_ids. */
  primary_integration_id: string;
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
  /** Short-form (<60s) vs long-form (typically 3-15min). Only
   *  meaningful for YouTube — TT/IG are short-form-only platforms. */
  video_format?: "short" | "long";
  /** Per-platform caption packaging — only the platforms the creator
   *  has connected get a variant. Shoot is shared (the script/hook/
   *  visual_notes above); this is the metadata that goes around it. */
  platforms?: PlatformPack;
};

export type VideoIdeasResult = {
  ok: boolean;
  ideas?: GeneratedIdea[];
  tokens?: number;
  error?: string;
};

// Recent settled reviews from the user's catalogue (fed into the
// prompt to ground new ideas in actual outcomes).
export type RecentReview = {
  title: string;
  kind: string;
  format: string | null;
  platform: string | null;
  verdict: string | null;
  ratio: number | null;
  takeaways: string | null;
};

// Recent thumbs-down rejections (fed into the prompt so the agent
// avoids regenerating things the creator already said no to).
export type RecentFeedback = {
  title: string;
  kind: string;
  format: string | null;
  hook: string | null;
  reason_code: string;
  free_text: string | null;
};
