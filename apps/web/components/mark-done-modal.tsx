"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/modal";

// Mark-done flow.
//
// On open we fire the /match endpoint to suggest which of the user's
// recent TikTok uploads this idea most likely produced. The top
// candidate is pre-selected if its score is meaningfully positive
// (>= 3) so the common case is one-click confirm. Otherwise the user
// pastes a URL.

export type MatchSuggestion = {
  id: string;
  url: string | null;
  caption: string;
  posted_at: string | null;
  views: number;
  likes: number;
  score: number;
  age_days: number;
  matched_hashtags: string[];
};

export function MarkDoneModal({
  open,
  ideaId,
  ideaTitle,
  onClose,
  onLinked,
}: {
  open: boolean;
  ideaId: string | null;
  ideaTitle: string | null;
  onClose: () => void;
  onLinked: () => void;
}) {
  const [matches, setMatches] = useState<MatchSuggestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state every time the modal reopens for a new idea.
  useEffect(() => {
    if (!open || !ideaId) {
      setMatches(null);
      setSelected(null);
      setManualUrl("");
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fetch(`/api/video-ideas/${ideaId}/match`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { matches?: MatchSuggestion[] };
        if (cancelled) return;
        const list = json.matches ?? [];
        setMatches(list);
        // Auto-select the top match if it scored meaningfully — saves
        // a click for the common case.
        if (list.length > 0 && (list[0]?.score ?? 0) >= 3) {
          setSelected(list[0]?.id ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Match failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ideaId]);

  async function submit() {
    if (!ideaId) return;
    let payload: { posted_video_id?: string; posted_video_url?: string };
    if (selected) {
      const match = matches?.find((m) => m.id === selected);
      payload = {
        posted_video_id: selected,
        posted_video_url: match?.url ?? undefined,
      };
    } else if (manualUrl.trim()) {
      payload = { posted_video_url: manualUrl.trim() };
    } else {
      setError("Pick a match or paste a URL.");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/video-ideas/${ideaId}/link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `Link failed (${res.status}).`);
        return;
      }
      onLinked();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function skip() {
    if (!ideaId) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/video-ideas/${ideaId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      if (!res.ok) {
        setError(`Skip failed (${res.status}).`);
        return;
      }
      onLinked();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={submitting ? () => {} : onClose}
      title="Mark as posted"
      subtitle={ideaTitle ?? undefined}
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Link this idea to the actual TikTok video so we can pull stats and
          write a performance review (first at 48h, final at 7d).
        </p>

        {loading && (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-4 text-center text-xs text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
            Looking through your recent TikTok uploads…
          </div>
        )}

        {!loading && matches && matches.length > 0 && (
          <div>
            <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
              Suggested matches
            </h4>
            <ul className="space-y-1.5">
              {matches.map((m) => {
                const active = selected === m.id;
                const confidence =
                  m.score >= 5
                    ? "Likely match"
                    : m.score >= 2
                      ? "Possible match"
                      : "Long shot";
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(m.id);
                        setManualUrl("");
                      }}
                      className={`w-full rounded-md border px-3 py-2 text-left text-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 ${
                        active
                          ? "border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-900"
                          : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-neutral-900 dark:text-neutral-100">
                          {confidence}
                        </span>
                        <span className="text-[10px] text-neutral-500">
                          {m.age_days < 1
                            ? "today"
                            : `${Math.round(m.age_days)}d ago`}{" "}
                          · {m.views.toLocaleString()} views
                        </span>
                      </div>
                      {m.caption && (
                        <p className="mt-1 line-clamp-2 text-neutral-600 dark:text-neutral-400">
                          {m.caption}
                        </p>
                      )}
                      {m.matched_hashtags.length > 0 && (
                        <p className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-300">
                          shared: {m.matched_hashtags.map((h) => `#${h}`).join(" ")}
                        </p>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {!loading && matches && matches.length === 0 && (
          <p className="text-xs text-neutral-500">
            No recent uploads found on this account. Paste the URL manually.
          </p>
        )}

        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500">
            Or paste the TikTok URL
          </label>
          <input
            type="text"
            placeholder="https://www.tiktok.com/@you/video/1234567890"
            value={manualUrl}
            onChange={(e) => {
              setManualUrl(e.target.value);
              if (e.target.value) setSelected(null);
            }}
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </div>

        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={skip}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-900"
          >
            Skip — just mark done
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || (!selected && !manualUrl.trim())}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
            >
              {submitting ? "Linking…" : "Link & schedule review"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
