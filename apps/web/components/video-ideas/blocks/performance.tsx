"use client";

import {
  PLATFORM_LABELS,
  VERDICT_COLORS,
  VERDICT_LABELS,
} from "../constants";
import { formatRelative, formatUntil } from "../helpers";
import type { PostedRow, VideoIdeaRow } from "../types";

// PerformanceBlock — the verdict + stats + post-mortem render inside
// the IdeaDetailModal for done ideas. Prefers the new per-platform
// posts array (one row per platform) and falls back to the legacy
// single-post columns on the idea row for pre-migration ideas.

export function PerformanceBlock({
  i,
  reviewingId,
  onReview,
}: {
  i: VideoIdeaRow;
  reviewingId: string | null;
  onReview: (postId?: string) => void;
}) {
  const posts = i.posts ?? [];
  if (posts.length > 0) {
    // Cross-platform synthesis lives on the idea row when 2+ posts
    // settled and the worker (or "Review now" all) wrote a synthesis.
    // performance_stats.cross_platform marks it so we don't confuse
    // it with the legacy single-post performance_review.
    const synthesisStats = i.performance_stats;
    const isCrossPlatform =
      posts.length > 1 &&
      !!i.performance_review &&
      synthesisStats?.cross_platform === true;
    return (
      <div className="mt-3 space-y-2">
        {isCrossPlatform && (
          <CrossPlatformSynthesis
            verdict={i.performance_verdict}
            review={i.performance_review!}
            stats={synthesisStats!}
            platformCount={posts.length}
          />
        )}
        {posts.map((p) => (
          <PostPerfRow
            key={p.id}
            post={p}
            reviewing={reviewingId === p.id}
            onReview={() => onReview(p.id)}
          />
        ))}
      </div>
    );
  }

  const reviewing = reviewingId === i.id;
  const stats = i.performance_stats;
  const verdict = i.performance_verdict;
  const hasReview = !!i.performance_review;
  return (
    <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="flex flex-wrap items-center gap-2">
        {verdict ? (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_COLORS[verdict]}`}
          >
            {VERDICT_LABELS[verdict]}
            {stats?.ratio != null && verdict !== "too_early" && (
              <span className="ml-1 opacity-75">
                · {stats.ratio.toFixed(2)}× median
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            Review pending
          </span>
        )}
        {i.posted_at && (
          <span className="text-[11px] text-neutral-500">
            posted {formatRelative(i.posted_at)}
          </span>
        )}
        {!verdict && i.next_review_at && (
          <span className="text-[11px] text-neutral-500">
            · next review {formatUntil(i.next_review_at)}
          </span>
        )}
        {i.posted_video_url && (
          <a
            href={i.posted_video_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11px] text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Open ↗
          </a>
        )}
      </div>

      {stats && (stats.views ?? 0) > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <Stat label="Views" value={(stats.views ?? 0).toLocaleString()} />
          <Stat label="Likes" value={(stats.likes ?? 0).toLocaleString()} />
          <Stat
            label="Comments"
            value={(stats.comments ?? 0).toLocaleString()}
          />
          <Stat label="Shares" value={(stats.shares ?? 0).toLocaleString()} />
        </div>
      )}

      {hasReview && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
            Read post-mortem
          </summary>
          <div className="mt-1.5 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {i.performance_review}
          </div>
        </details>
      )}

      {i.posted_video_id && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => onReview()}
            disabled={reviewing}
            className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[11px] text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            {reviewing
              ? "Reviewing…"
              : hasReview
                ? "Re-review now"
                : "Review now"}
          </button>
        </div>
      )}
    </div>
  );
}

function CrossPlatformSynthesis({
  verdict,
  review,
  stats,
  platformCount,
}: {
  verdict: VideoIdeaRow["performance_verdict"];
  review: string;
  stats: NonNullable<VideoIdeaRow["performance_stats"]>;
  platformCount: number;
}) {
  return (
    <div className="rounded-md border border-indigo-200 bg-indigo-50/60 p-3 dark:border-indigo-900/60 dark:bg-indigo-950/30">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-indigo-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200">
          Cross-platform · {platformCount}
        </span>
        {verdict && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_COLORS[verdict]}`}
          >
            {VERDICT_LABELS[verdict]}
            {stats.ratio != null && (
              <span className="ml-1 opacity-75">
                · {stats.ratio.toFixed(2)}× avg
              </span>
            )}
          </span>
        )}
        <span className="text-[11px] text-neutral-500">
          {(stats.views ?? 0).toLocaleString()} total views
        </span>
      </div>
      <details className="mt-2 text-xs" open>
        <summary className="cursor-pointer text-neutral-700 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100">
          Read cross-platform synthesis
        </summary>
        <div className="mt-1.5 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
          {review}
        </div>
      </details>
    </div>
  );
}

function PostPerfRow({
  post,
  reviewing,
  onReview,
}: {
  post: PostedRow;
  reviewing: boolean;
  onReview: () => void;
}) {
  const stats = post.performance_stats;
  const verdict = post.performance_verdict;
  const hasReview = !!post.performance_review;
  const platformLabel = PLATFORM_LABELS[post.platform] ?? post.platform;
  return (
    <div className="rounded-md border border-neutral-200 bg-neutral-50/60 p-3 dark:border-neutral-800 dark:bg-neutral-900/60">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {platformLabel}
        </span>
        {verdict ? (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_COLORS[verdict]}`}
          >
            {VERDICT_LABELS[verdict]}
            {stats?.ratio != null && verdict !== "too_early" && (
              <span className="ml-1 opacity-75">
                · {stats.ratio.toFixed(2)}× median
              </span>
            )}
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            Review pending
          </span>
        )}
        <span className="text-[11px] text-neutral-500">
          posted {formatRelative(post.posted_at)}
        </span>
        {!verdict && post.next_review_at && (
          <span className="text-[11px] text-neutral-500">
            · next review {formatUntil(post.next_review_at)}
          </span>
        )}
        {post.posted_video_url && (
          <a
            href={post.posted_video_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11px] text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Open on {platformLabel} ↗
          </a>
        )}
      </div>

      {stats && (stats.views ?? 0) > 0 && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <Stat label="Views" value={(stats.views ?? 0).toLocaleString()} />
          <Stat label="Likes" value={(stats.likes ?? 0).toLocaleString()} />
          <Stat
            label="Comments"
            value={(stats.comments ?? 0).toLocaleString()}
          />
          <Stat label="Shares" value={(stats.shares ?? 0).toLocaleString()} />
        </div>
      )}

      {hasReview && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100">
            Read {platformLabel} post-mortem
          </summary>
          <div className="mt-1.5 whitespace-pre-wrap text-neutral-700 dark:text-neutral-300">
            {post.performance_review}
          </div>
        </details>
      )}

      <div className="mt-2">
        <button
          type="button"
          onClick={onReview}
          disabled={reviewing}
          className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-[11px] text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          {reviewing
            ? "Reviewing…"
            : hasReview
              ? "Re-review now"
              : "Review now"}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-neutral-200 bg-white px-2 py-1 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        {value}
      </div>
    </div>
  );
}
