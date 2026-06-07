// Display constants shared across the video-ideas UI. Extracted from
// the monolith file. Keep declarative — no React, no hooks.

import type { VideoIdeaRow } from "./types";

export const KIND_LABELS: Record<VideoIdeaRow["kind"], string> = {
  pattern: "Pattern",
  trend: "Trend",
  rising: "↗ Rising",
  competitor: "Competitor",
  seasonal: "Seasonal",
};

export const KIND_COLORS: Record<VideoIdeaRow["kind"], string> = {
  pattern:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  trend: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  // Rising gets a brighter, more saturated treatment so it actively
  // catches the eye in a list — these have the shortest TTL and are
  // the user's "act fast" candidates.
  rising:
    "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/50 dark:text-fuchsia-200 ring-1 ring-fuchsia-300/60 dark:ring-fuchsia-800/60",
  competitor:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  seasonal:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

export const PROVIDER_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
};

// Alias — kept around because some inline code uses PLATFORM_LABELS
// for the same lookup. Single source of truth.
export const PLATFORM_LABELS = PROVIDER_LABELS;

// Per-provider tinted chip background. Single source of truth — used
// by the chip-row + settings modal + cards.
export const PROVIDER_CHIP_CLASS: Record<string, string> = {
  tiktok: "bg-pink-100 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200",
  youtube: "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200",
  instagram:
    "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-200",
};

export const VERDICT_LABELS: Record<
  NonNullable<VideoIdeaRow["performance_verdict"]>,
  string
> = {
  hit: "Hit",
  on_track: "On track",
  underperformed: "Underperformed",
  too_early: "Too early to tell",
};

export const VERDICT_COLORS: Record<
  NonNullable<VideoIdeaRow["performance_verdict"]>,
  string
> = {
  hit: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  on_track:
    "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
  underperformed:
    "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  too_early:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
};

// Preset reasons surfaced in the thumbs-down feedback modal. Keep in
// sync with the backend's VALID_REASONS in
// apps/web/app/api/video-ideas/[id]/feedback/route.ts and the
// REASON_LABELS map in packages/core/src/agents/video-ideas-agent.ts.
export const FEEDBACK_REASONS: Array<{ code: string; label: string }> = [
  { code: "outdated_trend", label: "Outdated trend" },
  { code: "wrong_voice", label: "Doesn't fit my voice" },
  { code: "flopped_before", label: "Tried similar — flopped" },
  { code: "platform_wrong", label: "Platform-wrong (TT trick on YT, etc.)" },
  { code: "off_brand", label: "Off-brand topic" },
  { code: "other", label: "Other" },
];
