"use client";

import { AlertTriangle, GripVertical, ThumbsDown } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  KIND_COLORS,
  KIND_LABELS,
  PLATFORM_LABELS,
  PROVIDER_LABELS,
  VERDICT_COLORS,
  VERDICT_LABELS,
} from "../constants";
import {
  accountTitle,
  expiresLabel,
  isUrgent,
  providerChipClass,
} from "../helpers";
import type { IdeasAccount, VideoIdeaRow } from "../types";

// Compact card — clickable header that opens the detail modal.
// Everything substantive (script, captions, virality breakdown, action
// buttons) lives in the modal; the card itself is a kind chip + status
// signal + title + 1-line hook tease. Mirrors what the user can scan
// in a master feed without having to expand every card.
export function CompactIdeaCard({
  i,
  account,
  targets,
  onOpen,
  onThumbsDown,
}: {
  i: VideoIdeaRow;
  /** Back-compat: the primary account. Used as the platform/account
   *  fallback when `targets` isn't provided. */
  account: IdeasAccount | null;
  /** Optional: the full set of accounts this idea targets. When
   *  provided AND length > 1, renders a chip per target instead of
   *  a single platform chip. Single-target ideas should pass `null`
   *  (or a single-element array — same result). */
  targets?: IdeasAccount[] | null;
  onOpen: () => void;
  onThumbsDown?: () => void;
}) {
  // Verdict resolution: idea.performance_verdict only gets populated
  // when cross-platform synthesis fires (2+ posts settled). Single-
  // platform posts + imported videos store their verdict on the
  // video_idea_posts row instead. Fall back to the post-level verdict
  // so a card that's actually been reviewed never shows "Review
  // pending" just because synthesis hasn't run.
  const reviewedPost = i.posts?.find((p) => !!p.performance_verdict);
  const verdict = i.performance_verdict ?? reviewedPost?.performance_verdict ?? null;
  const ratio =
    i.performance_stats?.ratio ?? reviewedPost?.performance_stats?.ratio;
  const ready =
    !!i.script ||
    !!i.description ||
    (i.hashtags?.length ?? 0) > 0 ||
    !!i.platforms?.tiktok ||
    !!i.platforms?.youtube ||
    !!i.platforms?.instagram;
  // Platform chips. Multi-target ideas render one per target; the
  // tooltip reveals the account label on hover. Single-target ideas
  // fall back to the legacy single-chip behaviour using `account`.
  const chipTargets: IdeasAccount[] =
    targets && targets.length > 0 ? targets : account ? [account] : [];
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="block w-full cursor-pointer px-4 py-3 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {chipTargets.length === 0 && (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-semibold text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
            {(i.provider ?? "").toLowerCase()}
          </span>
        )}
        {chipTargets.map((a) => {
          const platform = (a.provider ?? "").toLowerCase();
          const platformLabel =
            PLATFORM_LABELS[platform] ?? PROVIDER_LABELS[platform] ?? platform;
          const platformClass = providerChipClass(platform);
          const acctLabel = accountTitle(a);
          return (
            <span
              key={a.id}
              className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${platformClass}`}
              title={acctLabel}
            >
              {platformLabel}
            </span>
          );
        })}
        {i.video_format && (
          <span
            className="inline-flex items-center rounded-full bg-neutral-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
            title={
              i.video_format === "short"
                ? "Short-form video (≤60s)"
                : "Long-form video (typically 3-15min)"
            }
          >
            {i.video_format === "short" ? "Short" : "Long"}
          </span>
        )}
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${KIND_COLORS[i.kind]}`}
        >
          {KIND_LABELS[i.kind]}
        </span>
        {i.status === "done" && verdict && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${VERDICT_COLORS[verdict]}`}
          >
            {VERDICT_LABELS[verdict]}
            {ratio != null && verdict !== "too_early" && (
              <span className="ml-1 opacity-75">· {ratio.toFixed(2)}×</span>
            )}
          </span>
        )}
        {i.status === "done" && !verdict && (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            Review pending
          </span>
        )}
        {i.status !== "done" && i.status !== "scheduled" && (
          <span
            className={
              isUrgent(i.expires_at)
                ? "text-rose-600 dark:text-rose-400"
                : "text-neutral-500"
            }
          >
            {expiresLabel(i.expires_at)}
          </span>
        )}
        {i.saturation_warning && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            Saturated
          </span>
        )}
        {ready && i.status === "pending" && (
          <span className="ml-auto inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            Upload-ready
          </span>
        )}
        {onThumbsDown && i.status === "pending" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onThumbsDown();
            }}
            aria-label="This idea won't work — tell us why"
            title="This idea won't work — tell us why"
            className={`${
              ready ? "" : "ml-auto"
            } inline-flex h-5 w-5 items-center justify-center rounded-full text-neutral-400 transition hover:bg-rose-50 hover:text-rose-700 dark:text-neutral-500 dark:hover:bg-rose-950/30 dark:hover:text-rose-300`}
          >
            <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="mt-1.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {i.title}
      </p>
      {i.hook && (
        <p className="mt-1 line-clamp-1 text-xs text-neutral-500">
          {i.hook}
        </p>
      )}
    </div>
  );
}

// Sortable wrapper for the Working tab. Provides the grip handle on
// the left + position number + the dnd-kit transform/transition.
export function SortableIdeaCard({
  id,
  position,
  children,
}: {
  id: string;
  position: number;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 10 : "auto",
  };
  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`group flex items-stretch gap-2 rounded-lg border bg-white transition dark:bg-neutral-950 ${
        isDragging
          ? "border-neutral-900 shadow-lg dark:border-neutral-100"
          : "border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700"
      }`}
    >
      {/* Grip + position rail */}
      <div className="flex w-9 shrink-0 flex-col items-center gap-1 border-r border-neutral-100 py-4 dark:border-neutral-800/60">
        <button
          type="button"
          aria-label={`Drag to reorder (position ${position})`}
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none rounded p-1 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 active:cursor-grabbing dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
        >
          <GripVertical className="h-4 w-4" aria-hidden="true" />
        </button>
        <span className="font-mono text-[11px] font-medium text-neutral-500">
          {position}
        </span>
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </article>
  );
}
