"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";
import { KIND_LABELS, PROVIDER_LABELS } from "../constants";
import { accountTitle } from "../helpers";
import type { AccountGroup, VideoIdeaRow } from "../types";

// Import a video the user has already posted (back catalogue). Pasted
// URL → backend resolves platform + id + title + posted_at via the
// matching integration's token, drops a synthetic video_ideas+post
// row, and runs the review pipeline synchronously so the result is
// visible on close. Feeds future agent generations via recentReviews.
export function ImportVideoModal({
  open,
  groups,
  onClose,
  onImported,
}: {
  open: boolean;
  groups: AccountGroup[];
  onClose: () => void;
  onImported: (message: string) => void;
}) {
  const [accountId, setAccountId] = useState<string>(
    groups[0]?.account.id ?? "",
  );
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<VideoIdeaRow["kind"]>("pattern");
  const [titleOverride, setTitleOverride] = useState("");
  const [format, setFormat] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setUrl("");
      setKind("pattern");
      setTitleOverride("");
      setFormat("");
      setError(null);
      if (!accountId && groups[0]) setAccountId(groups[0].account.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit() {
    if (!accountId || !url.trim()) {
      setError("Pick an account and paste a video URL.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/video-ideas/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration_id: accountId,
          url: url.trim(),
          kind,
          title_override: titleOverride.trim() || undefined,
          format: format.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        setError(
          text.length > 0
            ? text.slice(0, 300)
            : `Import failed (${res.status}).`,
        );
        return;
      }
      const json = (await res.json()) as {
        title: string;
        verdict: string | null;
        ratio: number | null;
        review_error: string | null;
      };
      const verdictLabel = json.verdict
        ? ` · ${json.verdict}${
            json.ratio != null && json.verdict !== "too_early"
              ? ` (${json.ratio.toFixed(2)}×)`
              : ""
          }`
        : json.review_error
          ? " · review failed (will retry on the next worker tick)"
          : "";
      onImported(`Imported "${json.title.slice(0, 60)}"${verdictLabel}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const placeholders: Record<string, string> = {
    tiktok: "https://www.tiktok.com/@user/video/1234567890",
    youtube: "https://www.youtube.com/shorts/abc123… or /watch?v=…",
    instagram: "https://www.instagram.com/reel/Cxxxx/",
  };
  const currentProvider =
    groups.find((g) => g.account.id === accountId)?.account.provider ??
    "tiktok";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Import an existing video"
      subtitle="Pull stats + post-mortem on a video you already published. Feeds the agent's learning loop."
      maxWidth="max-w-lg"
    >
      <div className="space-y-4 text-sm">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Account
          </span>
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            {groups.map((g) => (
              <option key={g.account.id} value={g.account.id}>
                {PROVIDER_LABELS[g.account.provider] ?? g.account.provider} ·{" "}
                {accountTitle(g.account)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Video URL
          </span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={placeholders[currentProvider] ?? ""}
            className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as VideoIdeaRow["kind"])}
              className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              {(["pattern", "trend", "rising", "competitor", "seasonal"] as const).map(
                (k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
              Format <span className="text-neutral-500">(optional)</span>
            </span>
            <input
              type="text"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              placeholder='"acoustic vs classical comparison"'
              className="w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Title override{" "}
            <span className="text-neutral-500">
              (optional — defaults to the platform's title)
            </span>
          </span>
          <input
            type="text"
            value={titleOverride}
            onChange={(e) => setTitleOverride(e.target.value)}
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
            disabled={submitting || !url.trim()}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {submitting ? "Importing…" : "Import + review"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
