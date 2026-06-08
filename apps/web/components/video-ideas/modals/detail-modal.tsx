"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
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
import { EditableField } from "../editable-field";
import type { IdeasAccount, VideoIdeaRow } from "../types";

// IdeaDetailModal — opened from the master feed's compact cards.
//
// Inline editing: every content-shaped Section is wrapped in an
// EditableField. Click to edit; blur saves via PATCH; ✨ button asks
// the AI for 3 alternatives via /polish. Agent-controlled fields
// (kind, format, source_refs, expires_at, video_format) stay read-only
// because they drive expiry math + agent lookup patterns.

type PolishField =
  | "title"
  | "hook"
  | "script"
  | "post_title"
  | "description"
  | "cta"
  | "visual_notes"
  | "thumbnail_concept"
  | "engagement_hook"
  | "tiktok_caption"
  | "youtube_title"
  | "youtube_description"
  | "instagram_caption";

async function patchIdea(
  ideaId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`/api/video-ideas/${ideaId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Save failed (${res.status})`);
  }
}

async function fetchPolish(
  ideaId: string,
  field: PolishField,
  current: string,
  style?: "shorter" | "punchier" | "alt_take",
): Promise<Array<{ label: string; value: string }>> {
  const res = await fetch(`/api/video-ideas/${ideaId}/polish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ field, style, current }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(txt || `Polish failed (${res.status})`);
  }
  const data = (await res.json()) as {
    alternatives?: Array<{ label: string; value: string }>;
  };
  return data.alternatives ?? [];
}

export function IdeaDetailModal({
  idea,
  account,
  targets,
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
  targets?: IdeasAccount[] | null;
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
  const router = useRouter();
  const captionTabs = useMemo(() => buildCaptionTabs(idea), [idea]);
  const chipTargets: IdeasAccount[] =
    targets && targets.length > 0 ? targets : account ? [account] : [];
  const subtitleAccounts =
    chipTargets.length > 0
      ? chipTargets
          .map((a) => {
            const p = (a.provider ?? "").toLowerCase();
            const pLabel = PLATFORM_LABELS[p] ?? PROVIDER_LABELS[p] ?? p;
            return `${pLabel} · ${accountTitle(a)}`;
          })
          .join(" · ")
      : `${(idea.provider ?? "").toLowerCase()} · Unknown account`;

  // Bind a PATCH wrapper per field so EditableField's onSave stays
  // a () => Promise<void> shape. router.refresh() after each save so
  // the modal's parent picks up the new value.
  const editable = (field: PolishField) => {
    return {
      onSave: async (next: string) => {
        await patchIdea(idea.id, { [field]: next });
        router.refresh();
      },
      polish: {
        label: `Rewrite ${field.replace(/_/g, " ")}`,
        fetchAlternatives: (current: string) =>
          fetchPolish(idea.id, field, current),
      },
    };
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={idea.title}
      subtitle={`${subtitleAccounts} · ${KIND_LABELS[idea.kind]} · ${expiresLabel(idea.expires_at)}`}
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

        <Section title="Title" collapsible defaultOpen={false}>
          <EditableField
            value={idea.title}
            placeholder="Title…"
            required
            saveLabel="Save title"
            {...editable("title")}
          />
        </Section>

        {idea.rationale && (
          <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Why this could work:
            </span>{" "}
            {idea.rationale}
          </p>
        )}

        <Section
          title="Script"
          textToCopy={idea.script ?? undefined}
          collapsible
          defaultOpen
        >
          <EditableField
            value={idea.script}
            placeholder="Add a beat-by-beat script…"
            multiline
            monospace
            saveLabel="Save script"
            {...editable("script")}
          />
        </Section>

        <Section title="Hook" textToCopy={idea.hook ?? undefined}>
          <EditableField
            value={idea.hook}
            placeholder="First spoken/shown line…"
            saveLabel="Save hook"
            {...editable("hook")}
          />
        </Section>

        {captionTabs.length > 0 && <CaptionTabs tabs={captionTabs} />}

        <Section
          title="Call to action"
          textToCopy={idea.cta ?? undefined}
          collapsible
          defaultOpen={false}
        >
          <EditableField
            value={idea.cta}
            placeholder="One explicit ask…"
            saveLabel="Save CTA"
            {...editable("cta")}
          />
        </Section>

        <Section title="Visual notes" collapsible defaultOpen={false}>
          <EditableField
            value={idea.visual_notes}
            placeholder="Lighting, framing, props, B-roll…"
            multiline
            saveLabel="Save visual notes"
            {...editable("visual_notes")}
          />
        </Section>

        <Section title="Virality plan" collapsible defaultOpen={false}>
          <div className="space-y-2 rounded-md bg-neutral-50 px-3 py-3 text-xs dark:bg-neutral-900">
            <ViralityRow
              Icon={Clock}
              label="When to post"
              value={idea.optimal_post_window}
            />
            <ViralityRow
              Icon={Timer}
              label="Target length"
              value={idea.suggested_duration}
            />
            <ViralityRow
              Icon={ImageIcon}
              label="Cover / first frame"
              value={idea.thumbnail_concept}
            />
            <ViralityRow
              Icon={MessageCircle}
              label="Comment-driver"
              value={idea.engagement_hook}
            />
            <ViralityRow
              Icon={Music}
              label="Sound"
              value={idea.trending_sound}
            />
          </div>
        </Section>

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
