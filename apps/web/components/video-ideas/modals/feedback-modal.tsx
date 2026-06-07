"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { FEEDBACK_REASONS } from "../constants";

// Thumbs-down "this idea won't work" feedback modal. Distinct from
// Dismiss — Dismiss = "remove from queue, no judgment"; Feedback =
// "this is wrong AND here's why" → goes into video_idea_feedback +
// auto-dismisses the idea so it disappears from the master feed.
export function ThumbsDownFeedbackModal({
  open,
  ideaId,
  ideaTitle,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  ideaId: string | null;
  ideaTitle: string | null;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [reason, setReason] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason(null);
      setFreeText("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (!ideaId || !reason) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/video-ideas/${ideaId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason_code: reason,
          free_text: freeText.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(text.slice(0, 300) || `Save failed (${res.status}).`);
        return;
      }
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="This idea won't work"
      subtitle={
        ideaTitle
          ? `Telling us why helps the agent avoid the same pattern next refresh: "${ideaTitle.slice(0, 80)}"`
          : "Telling us why helps the agent avoid the same pattern next refresh."
      }
      maxWidth="max-w-lg"
    >
      <div className="space-y-4 text-sm">
        <div>
          <span className="mb-2 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Reason
          </span>
          <div className="flex flex-wrap gap-1.5">
            {FEEDBACK_REASONS.map((r) => {
              const active = reason === r.code;
              return (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => setReason(r.code)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    active
                      ? "bg-rose-600 text-white ring-2 ring-rose-600 ring-offset-1 ring-offset-white dark:ring-offset-neutral-950"
                      : "border border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Notes <span className="text-neutral-500">(optional)</span>
          </span>
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            rows={3}
            placeholder="e.g. 'this trend died 3 weeks ago' or 'tried this format last month — 0.3× median'"
            className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        {error && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={submitting || !reason}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 hover:bg-rose-700"
          >
            {submitting ? "Saving…" : "Send feedback"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
