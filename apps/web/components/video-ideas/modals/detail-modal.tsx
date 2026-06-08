"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Clock,
  Image as ImageIcon,
  MessageCircle,
  Music,
  Sparkles,
  ThumbsDown,
  Timer,
  X,
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
  const [reevalLoading, setReevalLoading] = useState(false);
  const [reevalResult, setReevalResult] = useState<{
    verdict: "keep" | "refine" | "drop";
    reasoning: string;
    refined_fields: Record<string, string> | null;
  } | null>(null);
  const [applying, setApplying] = useState(false);

  async function runReevaluate() {
    if (reevalLoading) return;
    setReevalLoading(true);
    setReevalResult(null);
    try {
      const res = await fetch(`/api/video-ideas/${idea.id}/reevaluate`, {
        method: "POST",
      });
      if (!res.ok) {
        const txt = await res.text();
        toast.error(txt || "Re-evaluation failed");
        return;
      }
      const json = (await res.json()) as {
        verdict: "keep" | "refine" | "drop";
        reasoning: string;
        refined_fields: Record<string, string> | null;
      };
      setReevalResult(json);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Re-evaluation failed");
    } finally {
      setReevalLoading(false);
    }
  }

  async function applyRefinements() {
    if (!reevalResult?.refined_fields) return;
    setApplying(true);
    try {
      const res = await fetch(`/api/video-ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reevalResult.refined_fields),
      });
      if (!res.ok) {
        toast.error((await res.text()) || "Apply failed");
        return;
      }
      toast.success("Applied — re-fetching idea.");
      setReevalResult(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }

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

        {reevalResult && (
          <ReevaluateResult
            result={reevalResult}
            applying={applying}
            onApply={applyRefinements}
            onDismiss={() => {
              onDismiss?.();
              setReevalResult(null);
            }}
            onClose={() => setReevalResult(null)}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="flex flex-wrap gap-2">
            {idea.status !== "done" && (
              <button
                type="button"
                onClick={runReevaluate}
                disabled={reevalLoading}
                title="Audit this idea against recent reviews + edits"
                className="inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-white px-3 py-1.5 text-xs text-violet-700 transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-900/60 dark:bg-neutral-900 dark:text-violet-300 dark:hover:bg-violet-950/30"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {reevalLoading ? "Re-evaluating…" : "Re-evaluate"}
              </button>
            )}
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

const VERDICT_STYLES = {
  keep: {
    container:
      "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30",
    label: "text-emerald-900 dark:text-emerald-200",
    badge:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
  refine: {
    container:
      "border-violet-200 bg-violet-50 dark:border-violet-900/60 dark:bg-violet-950/30",
    label: "text-violet-900 dark:text-violet-200",
    badge:
      "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  },
  drop: {
    container:
      "border-rose-200 bg-rose-50 dark:border-rose-900/60 dark:bg-rose-950/30",
    label: "text-rose-900 dark:text-rose-200",
    badge:
      "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  },
};

const VERDICT_LABEL = {
  keep: "Keep as-is",
  refine: "Refine suggested",
  drop: "Recommend dismissing",
};

function ReevaluateResult({
  result,
  applying,
  onApply,
  onDismiss,
  onClose,
}: {
  result: {
    verdict: "keep" | "refine" | "drop";
    reasoning: string;
    refined_fields: Record<string, string> | null;
  };
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onClose: () => void;
}) {
  const style = VERDICT_STYLES[result.verdict];
  const fieldEntries = result.refined_fields
    ? Object.entries(result.refined_fields).filter(([, v]) => !!v)
    : [];
  return (
    <div className={`rounded-lg border px-4 py-3 ${style.container}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles
            className={`h-4 w-4 ${style.label}`}
            aria-hidden="true"
          />
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${style.badge}`}
          >
            {VERDICT_LABEL[result.verdict]}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close re-evaluation"
          className="rounded-md p-1 text-neutral-500 transition hover:bg-white/60 dark:hover:bg-black/30"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <p className={`mt-2 text-sm ${style.label}`}>{result.reasoning}</p>

      {result.verdict === "refine" && fieldEntries.length > 0 && (
        <div className="mt-3 space-y-2">
          {fieldEntries.map(([field, value]) => (
            <div
              key={field}
              className="rounded-md bg-white/80 px-3 py-2 text-xs dark:bg-black/20"
            >
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-violet-700 dark:text-violet-300">
                {field.replace(/_/g, " ")}
              </div>
              <div className="whitespace-pre-wrap text-neutral-800 dark:text-neutral-200">
                {value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {result.verdict === "refine" && fieldEntries.length > 0 && (
          <button
            type="button"
            onClick={onApply}
            disabled={applying}
            className="inline-flex items-center gap-1.5 rounded-md bg-violet-700 px-3 py-1 text-xs font-medium text-white transition hover:bg-violet-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Check className="h-3 w-3" aria-hidden="true" />
            {applying ? "Applying…" : "Apply refinements"}
          </button>
        )}
        {result.verdict === "drop" && (
          <button
            type="button"
            onClick={onDismiss}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-700 px-3 py-1 text-xs font-medium text-white transition hover:bg-rose-800"
          >
            Dismiss this idea
          </button>
        )}
      </div>
    </div>
  );
}
