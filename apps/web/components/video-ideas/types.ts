// Shared types for the /video-ideas surface. Extracted from
// components/video-ideas-list.tsx so the main file isn't 3k lines of
// mixed concerns. Keep this file declarative only — no logic, no
// React imports.

export type VideoIdeaRow = {
  id: string;
  provider: string;
  integration_id: string | null;
  title: string;
  hook: string | null;
  format: string | null;
  rationale: string | null;
  kind: "pattern" | "trend" | "rising" | "competitor" | "seasonal";
  source_refs: Record<string, unknown> | null;
  saturation_warning: string | null;
  /** "short" | "long" | null — only YouTube ideas distinguish; TT/IG
   *  are short-only platforms so this is null for them. */
  video_format: "short" | "long" | null;
  expires_at: string;
  status: "pending" | "scheduled" | "done" | "dismissed";
  priority: number;
  created_at: string;
  script: string | null;
  post_title: string | null;
  description: string | null;
  hashtags: string[] | null;
  cta: string | null;
  visual_notes: string | null;
  optimal_post_window: string | null;
  suggested_duration: string | null;
  thumbnail_concept: string | null;
  engagement_hook: string | null;
  trending_sound: string | null;
  posted_video_id: string | null;
  posted_video_url: string | null;
  posted_at: string | null;
  performance_verdict:
    | "hit"
    | "on_track"
    | "underperformed"
    | "too_early"
    | null;
  performance_score: number | null;
  performance_review: string | null;
  performance_stats: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    engagement_rate?: number;
    baseline_median_rate?: number;
    ratio?: number;
    /** True when this stats blob is the cross-platform synthesis
     *  aggregate (totals across all platforms + average ratio) rather
     *  than the legacy single-post stats. */
    cross_platform?: boolean;
    platform_count?: number;
  } | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  /** Per-platform posts. Multi-row when the same shoot landed on more
   *  than one platform (TikTok + YT Shorts + IG Reels). Empty array
   *  for ideas that haven't been marked posted yet. */
  posts?: PostedRow[];
  /** Per-platform caption packaging produced by the generator. Only
   *  the platforms the user has connected are populated; legacy ideas
   *  pre-Phase-3 have this null and fall back to post_title /
   *  description / hashtags. */
  platforms?: {
    tiktok?: { caption: string; hashtags: string[] };
    youtube?: { title: string; description: string; hashtags: string[] };
    instagram?: { caption: string; hashtags: string[] };
  } | null;
};

export type PostedRow = {
  id: string;
  integration_id: string;
  platform: string;
  posted_video_id: string;
  posted_video_url: string | null;
  posted_at: string;
  performance_verdict:
    | "hit"
    | "on_track"
    | "underperformed"
    | "too_early"
    | null;
  performance_score: number | null;
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
  last_reviewed_at: string | null;
  next_review_at: string | null;
};

export type IdeasAccount = {
  id: string;
  provider: string;
  handle: string | null;
  displayName: string | null;
  accountLabel: string | null;
  providerAccountId: string;
};

export type LinkableAccount = {
  id: string;
  platform: string;
  label: string;
};

export type ActiveGenerationJob = {
  id: string;
  step_count: number;
  step_label: string;
  requested_count: number | null;
  started_at: string;
};

// One account's bundle of data on the master /video-ideas page. Each
// account (= each connected TT/YT/IG integration) gets its own section
// in the unified feed. The agent generates ideas natively for the
// account's own platform — no cross-pack at generation time — and the
// section renders a compact card grid for that account's ideas.
export type AccountGroup = {
  account: IdeasAccount;
  ideas: VideoIdeaRow[];
  targetCount: number;
  preferences: string | null;
  activeJob: ActiveGenerationJob | null;
};

export type KindFilter = "all" | VideoIdeaRow["kind"];
