"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Modal } from "@/components/modal";

// Mark-done flow — multi-platform aware.
//
// The user can log the same idea as posted on multiple connected
// accounts (TikTok + YouTube Shorts + Instagram Reels). Each account
// gets its own URL input. The source integration (the one the idea
// was generated for) gets the auto-match suggestion if it's a TikTok
// account.

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

export type LinkTarget = {
  /** Integration row id. */
  id: string;
  /** Platform: 'tiktok' | 'youtube' | 'instagram'. */
  platform: string;
  /** User-visible label, e.g. "Guitar Channel (@guitarist)". */
  label: string;
  /** True if this is the integration the idea was generated for. */
  isSource: boolean;
};

const PLATFORM_PLACEHOLDERS: Record<string, string> = {
  tiktok: "https://www.tiktok.com/@you/video/1234567890",
  youtube: "https://www.youtube.com/shorts/abc123 or https://youtu.be/abc123",
  instagram: "https://www.instagram.com/reel/Cxxxxx/",
};

export function MarkDoneModal({
  open,
  ideaId,
  ideaTitle,
  targets,
  onClose,
  onLinked,
}: {
  open: boolean;
  ideaId: string | null;
  ideaTitle: string | null;
  targets: LinkTarget[];
  onClose: () => void;
  onLinked: () => void;
}) {
  // URL inputs keyed by integration_id.
  const [urls, setUrls] = useState<Record<string, string>>({});
  // TikTok auto-match (only for the source TikTok integration, if any).
  const [matches, setMatches] = useState<MatchSuggestion[] | null>(null);
  const [matchLoading, setMatchLoading] = useState(false);
  const [pickedMatch, setPickedMatch] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceTikTok = targets.find(
    (t) => t.isSource && t.platform === "tiktok",
  );

  // Reset whenever the modal opens for a new idea.
  useEffect(() => {
    if (!open || !ideaId) {
      setUrls({});
      setMatches(null);
      setPickedMatch(null);
      setError(null);
      return;
    }
    setUrls({});
    setPickedMatch(null);
    setError(null);
    // Fire auto-match if there's a TikTok source.
    if (!sourceTikTok) return;
    let cancelled = false;
    setMatchLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/video-ideas/${ideaId}/match`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { matches?: MatchSuggestion[] };
        if (cancelled) return;
        const list = json.matches ?? [];
        setMatches(list);
        if (list.length > 0 && (list[0]?.score ?? 0) >= 3 && list[0]?.url) {
          setPickedMatch(list[0].id);
          setUrls((u) => ({ ...u, [sourceTikTok.id]: list[0]!.url! }));
        }
      } catch {
        // Match failure is non-fatal — user can still paste a URL.
      } finally {
        if (!cancelled) setMatchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, ideaId, sourceTikTok?.id, sourceTikTok]);

  const filledCount = Object.values(urls).filter((u) => u.trim()).length;

  async function submit() {
    if (!ideaId) return;
    const posts = targets
      .map((t) => ({ integration_id: t.id, url: urls[t.id]?.trim() ?? "" }))
      .filter((p) => p.url.length > 0);
    if (posts.length === 0) {
      setError("Paste at least one URL or hit Skip.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/video-ideas/${ideaId}/link`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posts }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        linked?: number;
        errors?: string[];
      };
      if (!res.ok) {
        setError(json.error ?? `Link failed (${res.status}).`);
        return;
      }
      if (json.errors && json.errors.length > 0) {
        // Partial success — still close, but flag the issues.
        console.warn("[mark-done] partial link errors:", json.errors);
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
      maxWidth="max-w-xl"
    >
      <div className="space-y-4">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Paste the URL for each platform you posted to. Each one gets its own
          performance review (first at 48h, settled at 7d). Leave a field
          blank if you didn&apos;t post there.
        </p>

        <div className="space-y-3">
          {targets.map((t) => {
            const isTikTokSource = t.id === sourceTikTok?.id;
            return (
              <div key={t.id}>
                <label
                  htmlFor={`link-url-${t.id}`}
                  className="mb-1 flex items-center justify-between gap-2 text-xs"
                >
                  <span className="font-medium text-neutral-700 dark:text-neutral-300">
                    {t.label}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-neutral-500">
                    {t.platform}
                    {t.isSource && " · source"}
                  </span>
                </label>
                <input
                  id={`link-url-${t.id}`}
                  type="text"
                  placeholder={
                    PLATFORM_PLACEHOLDERS[t.platform] ?? "Post URL"
                  }
                  value={urls[t.id] ?? ""}
                  onChange={(e) => {
                    setUrls((u) => ({ ...u, [t.id]: e.target.value }));
                    if (isTikTokSource) setPickedMatch(null);
                  }}
                  className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                />

                {/* Auto-match suggestions on the source TikTok */}
                {isTikTokSource && matchLoading && (
                  <p className="mt-1 inline-flex items-center gap-1 text-[10px] text-neutral-500">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    Looking through your recent uploads…
                  </p>
                )}
                {isTikTokSource &&
                  !matchLoading &&
                  matches &&
                  matches.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {matches.slice(0, 3).map((m) => {
                        const active = pickedMatch === m.id;
                        const confidence =
                          m.score >= 5
                            ? "Likely"
                            : m.score >= 2
                              ? "Possible"
                              : "Long shot";
                        return (
                          <li key={m.id}>
                            <button
                              type="button"
                              onClick={() => {
                                if (!m.url) return;
                                setPickedMatch(m.id);
                                setUrls((u) => ({ ...u, [t.id]: m.url! }));
                              }}
                              className={`w-full rounded-md border px-2.5 py-1.5 text-left text-[11px] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 ${
                                active
                                  ? "border-neutral-900 bg-neutral-50 dark:border-neutral-100 dark:bg-neutral-900"
                                  : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-900"
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium text-neutral-900 dark:text-neutral-100">
                                  {confidence} match
                                </span>
                                <span className="text-[10px] text-neutral-500">
                                  {m.age_days < 1
                                    ? "today"
                                    : `${Math.round(m.age_days)}d ago`}{" "}
                                  · {m.views.toLocaleString()} views
                                </span>
                              </div>
                              {m.caption && (
                                <p className="mt-0.5 line-clamp-1 text-neutral-600 dark:text-neutral-400">
                                  {m.caption}
                                </p>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
              </div>
            );
          })}
        </div>

        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}

        <div className="flex items-center justify-between gap-2 pt-2">
          <button
            type="button"
            onClick={skip}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-xs text-neutral-500 transition hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:hover:bg-neutral-900"
          >
            Skip — just mark done
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="rounded-md px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={submitting || filledCount === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-500 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
            >
              {submitting && (
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              )}
              {submitting
                ? "Linking"
                : `Link ${filledCount > 0 ? `${filledCount} post${filledCount === 1 ? "" : "s"}` : "posts"}`}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
