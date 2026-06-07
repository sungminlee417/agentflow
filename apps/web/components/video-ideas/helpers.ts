// Pure utility helpers shared across the video-ideas surface.
// Extracted from the monolith file. No React, no hooks, no Supabase.

import { PROVIDER_CHIP_CLASS } from "./constants";
import type { IdeasAccount, VideoIdeaRow } from "./types";

export function expiresLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expires in ${days}d`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `expires in ${hours}h`;
}

export function isUrgent(iso: string): boolean {
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 && ms < 3 * 86_400_000;
}

export function accountTitle(a: IdeasAccount): string {
  if (a.accountLabel) return a.accountLabel;
  if (a.displayName && a.handle) return `${a.displayName} (@${a.handle})`;
  if (a.displayName) return a.displayName;
  if (a.handle) return `@${a.handle}`;
  return "Legacy account";
}

export function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function formatUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}

export function providerChipClass(
  provider: string | null | undefined,
): string {
  return (
    PROVIDER_CHIP_CLASS[(provider ?? "").toLowerCase()] ??
    "bg-neutral-100 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
  );
}

// Resolve a single ratio to show on the card / sort by, with the same
// fallback rule as the verdict chip: idea.performance_stats only gets
// populated by cross-platform synthesis; single-platform posts +
// imports keep their stats on the post row. Without this fallback,
// imported videos sort to the bottom of "best performing" even when
// they're hits.
export function cardRatio(i: VideoIdeaRow): number | undefined {
  if (i.performance_stats?.ratio != null) return i.performance_stats.ratio;
  const reviewedPost = i.posts?.find(
    (p) => p.performance_stats?.ratio != null,
  );
  return reviewedPost?.performance_stats?.ratio;
}
