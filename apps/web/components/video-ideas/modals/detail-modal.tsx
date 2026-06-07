"use client";

import { useMemo } from "react";
import {
  Clock,
  Image as ImageIcon,
  MessageCircle,
  Music,
  ThumbsDown,
  Timer,
} from "lucide-react";
import { Modal } from "@/components/modal";
import {
  buildCaptionTabs,
  CaptionTabs,
  Section,
} from "../blocks/caption";
import { PerformanceBlock } from "../blocks/performance";
import { SourceRefs, ViralityRow } from "../blocks/virality";
import { KIND_LABELS, PLATFORM_LABELS, PROVIDER_LABELS } from "../constants";
import { accountTitle, expiresLabel } from "../helpers";
import type { IdeasAccount, VideoIdeaRow } from "../types";

// IdeaDetailModal — opened from the master feed's compact cards.
//
// Layout decisions:
// 1. Top: PerformanceBlock for done ideas (verdict + stats + post-
//    mortem). Always visible since it's the whole point of reviewing.
// 2. Rationale line — short, always visible.
// 3. Script — primary content, expanded by default. Collapsible so
//    after the user has read it once they can collapse to see the
//    caption + virality below without scrolling.
// 4. Caption tabs — primary content, always visible.
// 5. Secondary content (CTA / Visual notes / Virality plan / Source
//    evidence) — COLLAPSED by default. The modal was reportedly
//    overwhelming on open; tucking the less-frequently-used sections
//    behind disclosures reduces the visual load while keeping them
//    one click away.
// 6. Action toolbar — sticky-feeling row at the bottom.

export function IdeaDetailModal({
  idea,
  account,
  reviewingId,
  onClose,
  onSchedule,
  onDone,
  onUnschedule,
  onDismiss,
  onThumbsDown,
  onDeletePosted,
  onReview,
}: {
  idea: VideoIdeaRow;
  account: IdeasAccount | null;
  reviewingId: string | null;
  onClose: () => void;
  onSchedule: () => void;
  onDone: () => void;
  onUnschedule?: () => void;
  onDismiss?: () => void;
  onThumbsDown?: () => void;
  onDeletePosted?: () => void;
  onReview?: (postId?: string) => void;
}) {
  const captionTabs = useMemo(() => buildCaptionTabs(idea), [idea]);
  const platform = (idea.provider ?? account?.provider ?? "").toLowerCase();
  const platformLabel =
    PLATFORM_LABELS[platform] ?? PROVIDER_LABELS[platform] ?? platform;
  const accountLabel = account ? accountTitle(account) : "Unknown account";

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={idea.title}
      subtitle={`${platformLabel} · ${accountLabel} · ${KIND_LABELS[idea.kind]} · ${expiresLabel(idea.expires_at)}`}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-5">
        {idea.status === "done" && (
          <PerformanceBlock
            i={idea}
            reviewingId={reviewingId}
            onReview={(postId) => onReview?.(postId)}
          />
        )}
        {idea.rationale && (
          <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Why this could work:
            </span>{" "}
            {idea.rationale}
          </p>
        )}

        {idea.script ? (
          <Section
            title="Script"
            textToCopy={idea.script}
            collapsible
            defaultOpen
          >
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-neutral-50 px-3 py-3 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {idea.script}
            </pre>
          </Section>
        ) : idea.hook ? (
          <Section title="Hook" textToCopy={idea.hook}>
            <p className="rounded-md bg-neutral-50 px-3 py-3 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {idea.hook}
            </p>
          </Section>
        ) : null}

        {captionTabs.length > 0 && <CaptionTabs tabs={captionTabs} />}

        {idea.cta && (
          <Section
            title="Call to action"
            textToCopy={idea.cta}
            collapsible
            defaultOpen={false}
          >
            <p className="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {idea.cta}
            </p>
          </Section>
        )}

        {idea.visual_notes && (
          <Section title="Visual notes" collapsible defaultOpen={false}>
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-neutral-50 px-3 py-3 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
              {idea.visual_notes}
            </pre>
          </Section>
        )}

        {(idea.optimal_post_window ||
          idea.suggested_duration ||
          idea.thumbnail_concept ||
          idea.engagement_hook ||
          idea.trending_sound) && (
          <Section title="Virality plan" collapsible defaultOpen={false}>
            <div className="space-y-2 rounded-md bg-neutral-50 px-3 py-3 text-xs dark:bg-neutral-900">
              {idea.optimal_post_window && (
                <ViralityRow
                  Icon={Clock}
                  label="When to post"
                  value={idea.optimal_post_window}
                />
              )}
              {idea.suggested_duration && (
                <ViralityRow
                  Icon={Timer}
                  label="Target length"
                  value={idea.suggested_duration}
                />
              )}
              {idea.thumbnail_concept && (
                <ViralityRow
                  Icon={ImageIcon}
                  label="Cover / first frame"
                  value={idea.thumbnail_concept}
                />
              )}
              {idea.engagement_hook && (
                <ViralityRow
                  Icon={MessageCircle}
                  label="Comment-driver"
                  value={idea.engagement_hook}
                />
              )}
              {idea.trending_sound && (
                <ViralityRow
                  Icon={Music}
                  label="Sound"
                  value={idea.trending_sound}
                />
              )}
            </div>
          </Section>
        )}

        {idea.source_refs && Object.keys(idea.source_refs).length > 0 && (
          <Section title="Source evidence" collapsible defaultOpen={false}>
            <div className="text-[11px]">
              <SourceRefs refs={idea.source_refs} />
            </div>
          </Section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="flex flex-wrap gap-2">
            {idea.status === "pending" && onThumbsDown && (
              <button
                type="button"
                onClick={onThumbsDown}
                title="Tell us why so the next refresh avoids it"
                className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs text-rose-700 transition hover:bg-rose-50 dark:border-rose-900/60 dark:bg-neutral-900 dark:text-rose-300 dark:hover:bg-rose-950/30"
              >
                <ThumbsDown className="h-3.5 w-3.5" aria-hidden="true" />
                Won&apos;t work
              </button>
            )}
            {idea.status === "pending" && onDismiss && (
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                Dismiss
              </button>
            )}
            {idea.status === "scheduled" && onUnschedule && (
              <button
                type="button"
                onClick={onUnschedule}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
              >
                Move back to Ideas
              </button>
            )}
            {idea.status === "done" && onDeletePosted && (
              <button
                type="button"
                onClick={onDeletePosted}
                className="rounded-md border border-rose-200 bg-white px-3 py-1.5 text-xs text-rose-700 transition hover:bg-rose-50 dark:border-rose-900/60 dark:bg-neutral-900 dark:text-rose-300 dark:hover:bg-rose-950/30"
              >
                Delete
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {idea.status === "done" && onReview && (
              <button
                type="button"
                onClick={() => onReview()}
                disabled={reviewingId === idea.id}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                {reviewingId === idea.id ? "Reviewing…" : "Review now"}
              </button>
            )}
            {idea.status !== "scheduled" && idea.status !== "done" && (
              <button
                type="button"
                onClick={onSchedule}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                + Add to plan
              </button>
            )}
            {idea.status !== "done" && (
              <button
                type="button"
                onClick={onDone}
                className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
              >
                Mark posted…
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
