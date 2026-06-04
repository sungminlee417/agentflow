"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Modal } from "@/components/modal";
import { MarkDoneModal } from "@/components/mark-done-modal";
import { QuickAddIdea } from "@/components/quick-add-idea";
import { AccountPreferences } from "@/components/account-preferences";

export type VideoIdeaRow = {
  id: string;
  provider: string;
  integration_id: string | null;
  title: string;
  hook: string | null;
  format: string | null;
  rationale: string | null;
  kind: "pattern" | "trend" | "rising" | "competitor" | "seasonal";
  source_refs: Record<string, unknown> | null;
  saturation_warning: string | null;
  expires_at: string;
  status: "pending" | "scheduled" | "done" | "dismissed";
  priority: number;
  created_at: string;
  script: string | null;
  post_title: string | null;
  description: string | null;
  hashtags: string[] | null;
  cta: string | null;
  visual_notes: string | null;
  optimal_post_window: string | null;
  suggested_duration: string | null;
  thumbnail_concept: string | null;
  engagement_hook: string | null;
  trending_sound: string | null;
  posted_video_id: string | null;
  posted_video_url: string | null;
  posted_at: string | null;
  performance_verdict:
    | "hit"
    | "on_track"
    | "underperformed"
    | "too_early"
    | null;
  performance_score: number | null;
  performance_review: string | null;
  performance_stats: {
    views?: number;
    likes?: number;
    comments?: number;
    shares?: number;
    engagement_rate?: number;
    baseline_median_rate?: number;
    ratio?: number;
  } | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
};

export type IdeasAccount = {
  id: string;
  provider: string;
  handle: string | null;
  displayName: string | null;
  accountLabel: string | null;
  providerAccountId: string;
};

export type ActiveGenerationJob = {
  id: string;
  step_count: number;
  step_label: string;
  requested_count: number | null;
  started_at: string;
};

type KindFilter = "all" | VideoIdeaRow["kind"];

const KIND_LABELS: Record<VideoIdeaRow["kind"], string> = {
  pattern: "Pattern",
  trend: "Trend",
  rising: "↗ Rising",
  competitor: "Competitor",
  seasonal: "Seasonal",
};

const KIND_COLORS: Record<VideoIdeaRow["kind"], string> = {
  pattern:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  trend: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  // Rising gets a brighter, more saturated treatment so it actively
  // catches the eye in a list — these have the shortest TTL and are
  // the user's "act fast" candidates.
  rising:
    "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950/50 dark:text-fuchsia-200 ring-1 ring-fuchsia-300/60 dark:ring-fuchsia-800/60",
  competitor:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  seasonal:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

const PROVIDER_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
};

function expiresLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `expires in ${days}d`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `expires in ${hours}h`;
}

function isUrgent(iso: string): boolean {
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 && ms < 3 * 86_400_000;
}

function accountTitle(a: IdeasAccount): string {
  if (a.accountLabel) return a.accountLabel;
  if (a.displayName && a.handle) return `${a.displayName} (@${a.handle})`;
  if (a.displayName) return a.displayName;
  if (a.handle) return `@${a.handle}`;
  return "Legacy account";
}

export function VideoIdeasList({
  accounts,
  selectedAccountId,
  initial,
  targetCount,
  preferences,
  initialActiveJob,
}: {
  accounts: IdeasAccount[];
  selectedAccountId: string | null;
  initial: VideoIdeaRow[];
  targetCount: number;
  preferences?: string | null;
  initialActiveJob?: ActiveGenerationJob | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ideas, setIdeas] = useState<VideoIdeaRow[]>(initial);
  // Keep local state in sync with server props after router.refresh().
  useEffect(() => {
    setIdeas(initial);
  }, [initial]);
  const [target, setTarget] = useState(targetCount);
  useEffect(() => {
    setTarget(targetCount);
  }, [targetCount]);
  const [filter, setFilter] = useState<KindFilter>("all");
  // Track whether a generation is in flight either because we just
  // started it via SSE, or because the page loaded with an active job
  // already running server-side (user navigated away and came back).
  const [refreshing, setRefreshing] = useState(!!initialActiveJob);
  const [activeJobId, setActiveJobId] = useState<string | null>(
    initialActiveJob?.id ?? null,
  );
  const [progress, setProgress] = useState<{
    count: number;
    label: string;
  } | null>(
    initialActiveJob
      ? {
          count: initialActiveJob.step_count,
          label: initialActiveJob.step_label,
        }
      : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);

  // Abort controller for the in-flight SSE request from /api/video-ideas/
  // refresh. Lives in a ref so account-switching can reach in and cancel
  // it — without this, the dead stream from the previous account keeps
  // pushing progress / done / error events into the current account's
  // view, and "Generated N ideas" banners get attributed to the wrong
  // selection.
  const refreshAbortRef = useRef<AbortController | null>(null);

  // When the user switches accounts mid-generation, cut everything tied
  // to the previous account: kill the SSE fetch, drop the job-poll
  // identity, clear the progress card / banners. The polling effect
  // keys on activeJobId, so setting it to null naturally stops the
  // 2.5s loop without needing to touch it directly.
  useEffect(() => {
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    setActiveJobId(initialActiveJob?.id ?? null);
    setRefreshing(!!initialActiveJob);
    setProgress(
      initialActiveJob
        ? {
            count: initialActiveJob.step_count,
            label: initialActiveJob.step_label,
          }
        : null,
    );
    setMessage(null);
    setError(null);
    // We intentionally re-run on selectedAccountId AND on the server-
    // provided initialActiveJob — that pair fully describes "which
    // account, with which active job (if any)" the page is for now.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, initialActiveJob?.id]);

  // Poll the job row while a generation is active. This is the safety
  // net for the SSE stream — if the user navigates away and back, the
  // stream is dead but the job keeps updating, so polling catches us
  // up. Stops as soon as the job hits a final state.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled || !activeJobId) return;
      try {
        const res = await fetch(`/api/video-ideas/jobs/${activeJobId}`);
        if (cancelled) return;
        if (!res.ok) {
          // 404 / 500 etc — give up polling and reset UI state.
          setRefreshing(false);
          setActiveJobId(null);
          setProgress(null);
          return;
        }
        const json = (await res.json()) as {
          job?: {
            status: "running" | "done" | "failed";
            step_count: number;
            step_label: string | null;
            generated_count: number | null;
            error: string | null;
          };
        };
        const job = json.job;
        if (!job) {
          setRefreshing(false);
          setActiveJobId(null);
          setProgress(null);
          return;
        }
        setProgress({
          count: job.step_count,
          label: job.step_label ?? "Working…",
        });
        if (job.status === "done") {
          setRefreshing(false);
          setActiveJobId(null);
          setProgress(null);
          const generated = job.generated_count ?? 0;
          setMessage(
            generated > 0
              ? `Generated ${generated} new idea${generated === 1 ? "" : "s"}.`
              : "Already at target.",
          );
          router.refresh();
          return;
        }
        if (job.status === "failed") {
          setRefreshing(false);
          setActiveJobId(null);
          setProgress(null);
          setError(job.error ?? "Generation failed.");
          return;
        }
        timer = setTimeout(poll, 2500);
      } catch {
        if (cancelled) return;
        timer = setTimeout(poll, 3500);
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJobId, router]);
  const [detailIdeaId, setDetailIdeaId] = useState<string | null>(null);
  const detailIdea = useMemo(
    () => ideas.find((i) => i.id === detailIdeaId) ?? null,
    [ideas, detailIdeaId],
  );

  const [view, setView] = useState<"pending" | "scheduled" | "posted">(
    "pending",
  );

  const pendingIdeas = useMemo(
    () => ideas.filter((i) => i.status === "pending"),
    [ideas],
  );
  const scheduledIdeas = useMemo(
    () =>
      ideas
        .filter((i) => i.status === "scheduled")
        // Ascending priority = top of queue (= #1 user's working on
        // first). Ties broken by created_at so newly-promoted items
        // land predictably.
        .sort((a, b) => {
          if (a.priority !== b.priority) return a.priority - b.priority;
          return (
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
        }),
    [ideas],
  );
  const postedIdeas = useMemo(
    () =>
      ideas
        .filter((i) => i.status === "done")
        .sort((a, b) => {
          const aT = a.posted_at ?? a.created_at;
          const bT = b.posted_at ?? b.created_at;
          return new Date(bT).getTime() - new Date(aT).getTime();
        }),
    [ideas],
  );

  const baseForView = useCallback(
    (v: "pending" | "scheduled" | "posted") =>
      v === "pending"
        ? pendingIdeas
        : v === "scheduled"
          ? scheduledIdeas
          : postedIdeas,
    [pendingIdeas, scheduledIdeas, postedIdeas],
  );

  const filtered = useMemo(() => {
    const base = baseForView(view);
    if (filter === "all") return base;
    return base.filter((i) => i.kind === filter);
  }, [view, baseForView, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: 0,
      pattern: 0,
      rising: 0,
      trend: 0,
      competitor: 0,
      seasonal: 0,
    };
    const base = baseForView(view);
    for (const i of base) {
      c["all"] = (c["all"] ?? 0) + 1;
      c[i.kind] = (c[i.kind] ?? 0) + 1;
    }
    return c;
  }, [view, baseForView]);

  const [markDoneIdeaId, setMarkDoneIdeaId] = useState<string | null>(null);
  const markDoneIdea = useMemo(
    () => ideas.find((i) => i.id === markDoneIdeaId) ?? null,
    [ideas, markDoneIdeaId],
  );
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  // dnd-kit sensors. Pointer = mouse, Touch = mobile, Keyboard = a11y.
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIdx = scheduledIdeas.findIndex((i) => i.id === active.id);
    const toIdx = scheduledIdeas.findIndex((i) => i.id === over.id);
    if (fromIdx === -1 || toIdx === -1) return;

    // Optimistic reorder of the local state.
    const reordered = arrayMove(scheduledIdeas, fromIdx, toIdx);

    // Compute the new priority by averaging the neighbours at the
    // drop position. Large default gap (10000) leaves room for ~14
    // halving inserts before we'd ever need to rebalance.
    const moved = reordered[toIdx]!;
    const prevPriority = toIdx > 0 ? reordered[toIdx - 1]!.priority : null;
    const nextPriority =
      toIdx < reordered.length - 1 ? reordered[toIdx + 1]!.priority : null;
    let newPriority: number;
    if (prevPriority === null && nextPriority === null) {
      newPriority = 10000;
    } else if (prevPriority === null) {
      newPriority = (nextPriority as number) - 10000;
    } else if (nextPriority === null) {
      newPriority = prevPriority + 10000;
    } else {
      newPriority = Math.floor((prevPriority + nextPriority) / 2);
      // If neighbours are adjacent integers (no room), nudge — the
      // server will eventually rebalance if this becomes common.
      if (newPriority === prevPriority) newPriority = prevPriority + 1;
    }

    setIdeas((rows) =>
      rows.map((r) => (r.id === moved.id ? { ...r, priority: newPriority } : r)),
    );

    const res = await fetch(`/api/video-ideas/${moved.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: newPriority }),
    });
    if (!res.ok) {
      // Revert on failure.
      setIdeas((rows) =>
        rows.map((r) =>
          r.id === moved.id ? { ...r, priority: moved.priority } : r,
        ),
      );
      setError("Couldn't save the new order. Try again.");
    }
  }

  async function runReviewNow(id: string) {
    setReviewingId(id);
    setError(null);
    try {
      const res = await fetch(`/api/video-ideas/${id}/review`, {
        method: "POST",
      });
      if (!res.ok) {
        const text = await res.text();
        setError(`Review failed: ${text.slice(0, 200)}`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReviewingId(null);
    }
  }

  function switchAccount(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("account", id);
    router.push(`/video-ideas?${params.toString()}`);
  }

  async function refresh() {
    if (!selectedAccountId) {
      setError("No account selected.");
      return;
    }
    setRefreshing(true);
    setError(null);
    setMessage(null);
    setProgress({ count: 0, label: "Starting…" });
    // localSseDone tracks whether the SSE stream itself reached a
    // terminal event. If the user navigates away the stream gets cut
    // off and we fall through to the polling effect (which kicks in
    // because activeJobId is still set).
    let localSseDone = false;
    // Lock the integration id this refresh is for. If the user
    // switches accounts mid-stream we'll detect a mismatch and ignore
    // late events — protects against the previous account's stream
    // writing into the new account's view.
    const refreshIntegrationId = selectedAccountId;
    // Abort any previous in-flight refresh and install a new
    // controller. Stored in a ref so account-switching can cancel it.
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    try {
      const res = await fetch("/api/video-ideas/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration_id: selectedAccountId }),
        signal: controller.signal,
      });
      if (res.status === 409) {
        // Another run is already going for this account — adopt its
        // id and let the polling effect track it.
        const json = (await res.json().catch(() => ({}))) as {
          job_id?: string;
          error?: string;
        };
        if (json.job_id) {
          setActiveJobId(json.job_id);
          setProgress({ count: 0, label: "Resuming generation…" });
        } else {
          setError(json.error ?? "A generation is already running.");
          setRefreshing(false);
          setProgress(null);
        }
        return;
      }
      if (!res.ok || !res.body) {
        setError(`Refresh failed (${res.status}).`);
        setRefreshing(false);
        setProgress(null);
        return;
      }

      // Stream parser for SSE: read chunks, split on \n\n, parse
      // event/data pairs. Each frame either advances the progress
      // display, finishes the run, or surfaces an error.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalMessage: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) return;
        buffer += decoder.decode(value, { stream: true });

        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
          // Refuse to write into state if the user has since switched
          // accounts — this stream is for the old integration.
          if (refreshIntegrationId !== selectedAccountId) continue;
          let evtType = "message";
          let dataStr = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) evtType = line.slice(6).trim();
            else if (line.startsWith("data:")) dataStr = line.slice(5).trim();
          }
          if (!dataStr) continue;
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(dataStr);
          } catch {
            continue;
          }
          if (evtType === "job") {
            // Server returned the job row id — set it so the polling
            // effect can fall back to status checks if SSE drops.
            if (typeof payload.id === "string") {
              setActiveJobId(payload.id);
            }
          } else if (evtType === "prepare") {
            setProgress({ count: 0, label: String(payload.label ?? "Working…") });
          } else if (evtType === "step") {
            setProgress({
              count: Number(payload.count ?? 0),
              label: String(payload.label ?? "Working…"),
            });
          } else if (evtType === "inserting") {
            setProgress({
              count: Number(payload.generated ?? 0),
              label: "Saving ideas to your library…",
            });
          } else if (evtType === "done") {
            localSseDone = true;
            const generated = Number(payload.generated ?? 0);
            if (generated > 0) {
              finalMessage = `Generated ${generated} new idea${generated === 1 ? "" : "s"}.`;
            } else {
              finalMessage =
                typeof payload.message === "string"
                  ? payload.message
                  : "Already at target.";
            }
          } else if (evtType === "error") {
            localSseDone = true;
            setError(
              typeof payload.error === "string"
                ? payload.error
                : "Refresh failed.",
            );
            setRefreshing(false);
            setActiveJobId(null);
            setProgress(null);
            return;
          }
        }
      }

      // If the user switched accounts during the stream, suppress
      // everything that came from the old integration's run. Polling
      // for it has already been cancelled by the account-switch
      // effect.
      if (refreshIntegrationId !== selectedAccountId) return;
      if (localSseDone) {
        if (finalMessage) setMessage(finalMessage);
        router.refresh();
        setRefreshing(false);
        setActiveJobId(null);
        setProgress(null);
      }
      // If the stream ended without a done/error frame (e.g. tab was
      // backgrounded and reconnected), leave refreshing + activeJobId
      // set — the polling effect will take over from here.
    } catch (err) {
      // AbortError fires when the user switched accounts (we cancelled
      // the request) — that's expected, not an error to show.
      const aborted =
        err instanceof DOMException && err.name === "AbortError";
      if (aborted) return;
      // Don't surface state for a stream that's no longer for the
      // active account.
      if (refreshIntegrationId !== selectedAccountId) return;
      // Network drop — keep refreshing flag so the polling effect
      // (activeJobId-driven) continues to surface progress. If we
      // never even got a job id, fall back to error.
      if (!activeJobId) {
        setError(err instanceof Error ? err.message : String(err));
        setRefreshing(false);
        setProgress(null);
      }
    }
  }

  async function updateTarget(newTarget: number) {
    if (!selectedAccountId) return;
    setSavingTarget(true);
    try {
      const res = await fetch("/api/video-ideas/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          integration_id: selectedAccountId,
          target_count: newTarget,
        }),
      });
      if (res.ok) setTarget(newTarget);
    } finally {
      setSavingTarget(false);
    }
  }

  async function setStatus(id: string, status: VideoIdeaRow["status"]) {
    const prev = ideas;
    setIdeas((rows) =>
      rows.map((r) => (r.id === id ? { ...r, status } : r)),
    );
    const res = await fetch(`/api/video-ideas/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      setIdeas(prev);
      setError(`Update failed (${res.status}).`);
    }
  }

  async function remove(id: string) {
    const prev = ideas;
    setIdeas((rows) => rows.filter((r) => r.id !== id));
    const res = await fetch(`/api/video-ideas/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setIdeas(prev);
      setError(`Delete failed (${res.status}).`);
    }
  }

  // Group accounts by provider for the selector.
  const accountsByProvider = useMemo(() => {
    const map = new Map<string, IdeasAccount[]>();
    for (const a of accounts) {
      const list = map.get(a.provider) ?? [];
      list.push(a);
      map.set(a.provider, list);
    }
    return map;
  }, [accounts]);

  if (accounts.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Video ideas
        </h1>
        <div className="mt-6 rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
          Connect a TikTok account in{" "}
          <Link href="/integrations" className="underline">
            Integrations
          </Link>{" "}
          to start generating ideas.
        </div>
      </div>
    );
  }

  // Stats for the strip at the top — only meaningful when on the
  // posted view (or compact pending counts otherwise).
  const lastHit = useMemo(
    () =>
      postedIdeas.find(
        (i) =>
          i.performance_verdict === "hit" &&
          i.performance_stats?.ratio != null,
      ),
    [postedIdeas],
  );
  const reviewsPending = useMemo(
    () =>
      postedIdeas.filter(
        (i) => i.posted_video_id && !i.performance_verdict,
      ).length,
    [postedIdeas],
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:py-10">
      {/* Mobile leaves room for the fixed hamburger button (left-3 top-3) */}
      <header className="flex flex-wrap items-center justify-between gap-3 pl-10 md:pl-0">
        <div className="flex items-center gap-2">
          <select
            value={selectedAccountId ?? ""}
            onChange={(e) => switchAccount(e.target.value)}
            className="max-w-[60vw] truncate rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm font-medium text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            {[...accountsByProvider.entries()].map(([provider, list]) => (
              <optgroup
                key={provider}
                label={PROVIDER_LABELS[provider] ?? provider}
              >
                {list.map((a) => (
                  <option key={a.id} value={a.id}>
                    {accountTitle(a)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Link
            href="/integrations"
            className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            +
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className="hidden sm:inline">Target</span>
            <select
              value={target}
              onChange={(e) => updateTarget(Number(e.target.value))}
              disabled={savingTarget || !selectedAccountId}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            >
              {[5, 10, 15, 20, 30].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing || !selectedAccountId}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            {refreshing && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white dark:border-black/40 dark:border-t-black" />
            )}
            {refreshing ? "Generating" : "↻ Refresh"}
          </button>
        </div>
      </header>

      {/* Stat strip — quick glanceable state */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
        <span>
          <strong className="text-neutral-900 dark:text-neutral-100">
            {pendingIdeas.length}
          </strong>{" "}
          ready
        </span>
        <span>
          <strong className="text-neutral-900 dark:text-neutral-100">
            {postedIdeas.length}
          </strong>{" "}
          posted
        </span>
        {reviewsPending > 0 && (
          <span>
            <strong className="text-amber-700 dark:text-amber-300">
              {reviewsPending}
            </strong>{" "}
            awaiting review
          </span>
        )}
        {lastHit && (
          <span className="truncate">
            <span className="text-emerald-700 dark:text-emerald-300">★</span>{" "}
            last hit:{" "}
            <span className="text-neutral-900 dark:text-neutral-100">
              {lastHit.title.length > 40
                ? lastHit.title.slice(0, 40) + "…"
                : lastHit.title}
            </span>{" "}
            ({(lastHit.performance_stats?.ratio ?? 0).toFixed(1)}×)
          </span>
        )}
      </div>

      {refreshing && progress && (
        <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2.5 text-sm dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-center gap-2.5">
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-blue-500" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                {progress.count > 0 && (
                  <span className="font-mono text-[11px] text-blue-700 dark:text-blue-300">
                    step {progress.count}
                  </span>
                )}
                <span className="text-blue-900 dark:text-blue-100">
                  {progress.label}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-blue-700/70 dark:text-blue-300/70">
                30-60 seconds — runs server-side, safe to close the tab.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-6 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
      {message && !error && (
        <div className="mt-6 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300">
          {message}
        </div>
      )}

      <div className="mt-6 flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-100/60 p-1 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
        {(["pending", "scheduled", "posted"] as const).map((v) => {
          const active = view === v;
          const count =
            v === "pending"
              ? pendingIdeas.length
              : v === "scheduled"
                ? scheduledIdeas.length
                : postedIdeas.length;
          const label =
            v === "pending"
              ? "Ideas"
              : v === "scheduled"
                ? "Working on"
                : "Posted";
          return (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`flex-1 rounded px-3 py-1.5 font-medium transition ${
                active
                  ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-950 dark:text-neutral-100"
                  : "text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
              }`}
            >
              {label} <span className="opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {(["all", "pattern", "rising", "trend", "competitor", "seasonal"] as KindFilter[]).map(
          (k) => {
            const active = filter === k;
            const label = k === "all" ? "All" : KIND_LABELS[k];
            return (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  active
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "border border-neutral-300 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                }`}
              >
                {label}{" "}
                <span className="ml-1 opacity-60">{counts[k] ?? 0}</span>
              </button>
            );
          },
        )}
      </div>

      {view === "pending" && (
        <div className="mt-4 space-y-3">
          <AccountPreferences
            selectedAccountId={selectedAccountId}
            initial={preferences ?? null}
          />
          <QuickAddIdea selectedAccountId={selectedAccountId} />
        </div>
      )}

      <section className="mt-6 space-y-3">
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {view === "pending" &&
              (pendingIdeas.length === 0
                ? "No ideas yet for this account. Hit Refresh to generate the first batch."
                : "No ideas match this filter.")}
            {view === "scheduled" &&
              (scheduledIdeas.length === 0
                ? "Nothing in your queue. Pick an idea from the Ideas tab and hit “Add to plan” to commit to it."
                : "No queued ideas match this filter.")}
            {view === "posted" &&
              (postedIdeas.length === 0
                ? "Nothing posted yet. From your queue, mark an idea as posted to see how it performs."
                : "No posted videos match this filter.")}
          </div>
        )}

        {view === "scheduled" ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={filtered.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              {filtered.map((i, idx) => (
                <SortableIdeaCard
                  key={i.id}
                  id={i.id}
                  position={idx + 1}
                >
                  <IdeaCardBody
                    i={i}
                    reviewingId={reviewingId}
                    runReviewNow={runReviewNow}
                    setDetailIdeaId={setDetailIdeaId}
                    setStatus={setStatus}
                    setMarkDoneIdeaId={setMarkDoneIdeaId}
                    remove={remove}
                  />
                </SortableIdeaCard>
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          filtered.map((i) => (
            <article
              key={i.id}
              className="group rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-700"
            >
              <IdeaCardBody
                i={i}
                reviewingId={reviewingId}
                runReviewNow={runReviewNow}
                setDetailIdeaId={setDetailIdeaId}
                setStatus={setStatus}
                setMarkDoneIdeaId={setMarkDoneIdeaId}
                remove={remove}
              />
            </article>
          ))
        )}
      </section>

      <MarkDoneModal
        open={markDoneIdeaId !== null}
        ideaId={markDoneIdeaId}
        ideaTitle={markDoneIdea?.title ?? null}
        onClose={() => setMarkDoneIdeaId(null)}
        onLinked={() => {
          router.refresh();
          setMessage("Marked as posted. First review in ~48h.");
        }}
      />

      {detailIdea && (
        <IdeaDetailModal
          idea={detailIdea}
          onClose={() => setDetailIdeaId(null)}
          onSchedule={() => {
            setStatus(detailIdea.id, "scheduled");
            setDetailIdeaId(null);
          }}
          onDone={() => {
            setStatus(detailIdea.id, "done");
            setDetailIdeaId(null);
          }}
        />
      )}
    </div>
  );
}

function IdeaDetailModal({
  idea,
  onClose,
  onSchedule,
  onDone,
}: {
  idea: VideoIdeaRow;
  onClose: () => void;
  onSchedule: () => void;
  onDone: () => void;
}) {
  const captionWithTags = useMemo(() => {
    const body = [idea.post_title, idea.description]
      .filter((x) => !!x)
      .join("\n\n");
    const tags = (idea.hashtags ?? []).map((h) => `#${h}`).join(" ");
    return [body, tags].filter(Boolean).join("\n\n").trim();
  }, [idea]);

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={idea.title}
      subtitle={`${KIND_LABELS[idea.kind]} · ${expiresLabel(idea.expires_at)}`}
      maxWidth="max-w-3xl"
    >
      <div className="space-y-5">
        {idea.rationale && (
          <p className="rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400">
            <span className="font-medium text-neutral-700 dark:text-neutral-300">
              Why this could work:
            </span>{" "}
            {idea.rationale}
          </p>
        )}

        {idea.script ? (
          <Section title="Script" textToCopy={idea.script}>
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

        {(idea.post_title || idea.description) && (
          <Section
            title="Caption"
            textToCopy={captionWithTags}
            copyLabel="Copy caption + tags"
          >
            <div className="rounded-md bg-neutral-50 px-3 py-3 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {idea.post_title && (
                <p className="font-medium">{idea.post_title}</p>
              )}
              {idea.description && (
                <p className="mt-2 whitespace-pre-wrap">{idea.description}</p>
              )}
              {idea.hashtags && idea.hashtags.length > 0 && (
                <p className="mt-3 text-blue-700 dark:text-blue-300">
                  {idea.hashtags.map((h) => `#${h}`).join(" ")}
                </p>
              )}
            </div>
          </Section>
        )}

        {idea.hashtags && idea.hashtags.length > 0 && (
          <Section
            title="Hashtags"
            textToCopy={idea.hashtags.map((h) => `#${h}`).join(" ")}
          >
            <div className="flex flex-wrap gap-1.5">
              {idea.hashtags.map((h) => (
                <span
                  key={h}
                  className="rounded-full bg-blue-50 px-2.5 py-1 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
                >
                  #{h}
                </span>
              ))}
            </div>
          </Section>
        )}

        {idea.cta && (
          <Section title="Call to action" textToCopy={idea.cta}>
            <p className="rounded-md bg-neutral-50 px-3 py-2 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
              {idea.cta}
            </p>
          </Section>
        )}

        {idea.visual_notes && (
          <Section title="Visual notes">
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
          <Section title="Virality plan">
            <div className="space-y-2 rounded-md bg-neutral-50 px-3 py-3 text-xs dark:bg-neutral-900">
              {idea.optimal_post_window && (
                <ViralityRow
                  icon="🕒"
                  label="When to post"
                  value={idea.optimal_post_window}
                />
              )}
              {idea.suggested_duration && (
                <ViralityRow
                  icon="⏱"
                  label="Target length"
                  value={idea.suggested_duration}
                />
              )}
              {idea.thumbnail_concept && (
                <ViralityRow
                  icon="🖼"
                  label="Cover / first frame"
                  value={idea.thumbnail_concept}
                />
              )}
              {idea.engagement_hook && (
                <ViralityRow
                  icon="💬"
                  label="Comment-driver"
                  value={idea.engagement_hook}
                />
              )}
              {idea.trending_sound && (
                <ViralityRow
                  icon="🎵"
                  label="Sound"
                  value={idea.trending_sound}
                />
              )}
            </div>
          </Section>
        )}

        {idea.source_refs && Object.keys(idea.source_refs).length > 0 && (
          <Section title="Source evidence">
            <div className="text-[11px]">
              <SourceRefs refs={idea.source_refs} />
            </div>
          </Section>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          {idea.status !== "scheduled" && (
            <button
              type="button"
              onClick={onSchedule}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              + Add to plan
            </button>
          )}
          <button
            type="button"
            onClick={onDone}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Mark posted…
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Section({
  title,
  children,
  textToCopy,
  copyLabel = "Copy",
}: {
  title: string;
  children: React.ReactNode;
  textToCopy?: string;
  copyLabel?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          {title}
        </h3>
        {textToCopy && <CopyButton text={textToCopy} label={copyLabel} />}
      </div>
      {children}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

const VERDICT_LABELS: Record<NonNullable<VideoIdeaRow["performance_verdict"]>, string> = {
  hit: "Hit",
  on_track: "On track",
  underperformed: "Underperformed",
  too_early: "Too early to tell",
};

const VERDICT_COLORS: Record<
  NonNullable<VideoIdeaRow["performance_verdict"]>,
  string
> = {
  hit: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  on_track:
    "bg-neutral-100 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
  underperformed:
    "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  too_early:
    "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
};

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 86_400_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}

function PerformanceBlock({
  i,
  reviewing,
  onReview,
}: {
  i: VideoIdeaRow;
  reviewing: boolean;
  onReview: () => void;
}) {
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
            Open on TikTok ↗
          </a>
        )}
      </div>

      {stats && (stats.views ?? 0) > 0 && (
        <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
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
      )}
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

// Card body rendered inside the article (sortable or static). Lives
// here rather than inline in the map so both render paths stay in
// sync. All the per-card actions and the performance + virality
// blocks are part of this.
function IdeaCardBody({
  i,
  reviewingId,
  runReviewNow,
  setDetailIdeaId,
  setStatus,
  setMarkDoneIdeaId,
  remove,
}: {
  i: VideoIdeaRow;
  reviewingId: string | null;
  runReviewNow: (id: string) => void;
  setDetailIdeaId: (id: string) => void;
  setStatus: (id: string, status: VideoIdeaRow["status"]) => void;
  setMarkDoneIdeaId: (id: string) => void;
  remove: (id: string) => void;
}) {
  const hasFullContent =
    !!i.script || !!i.description || (i.hashtags?.length ?? 0) > 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${KIND_COLORS[i.kind]}`}
        >
          {KIND_LABELS[i.kind]}
        </span>
        {i.status !== "done" && i.status !== "scheduled" && (
          <span
            className={`text-xs ${
              isUrgent(i.expires_at)
                ? "text-rose-600 dark:text-rose-400"
                : "text-neutral-500"
            }`}
          >
            {expiresLabel(i.expires_at)}
          </span>
        )}
        {hasFullContent && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            Upload-ready
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => setDetailIdeaId(i.id)}
        className="mt-2 text-left text-sm font-semibold text-neutral-900 hover:underline dark:text-neutral-100"
      >
        {i.title}
      </button>
      {i.hook && (
        <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Hook ·{" "}
          </span>
          {i.hook}
        </p>
      )}
      {i.format && (
        <p className="mt-1 text-xs text-neutral-500">Format: {i.format}</p>
      )}
      {i.rationale && (
        <p className="mt-2 text-xs text-neutral-600 dark:text-neutral-400">
          {i.rationale}
        </p>
      )}
      {i.saturation_warning && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
          <span aria-hidden="true">⚠</span>
          <span>
            <span className="font-medium">Saturated · </span>
            {i.saturation_warning}
          </span>
        </div>
      )}
      <SourceRefs refs={i.source_refs} />
      <ViralityStrip i={i} />
      {i.status === "done" && (
        <PerformanceBlock
          i={i}
          reviewing={reviewingId === i.id}
          onReview={() => runReviewNow(i.id)}
        />
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setDetailIdeaId(i.id)}
          className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          View details →
        </button>
        {i.status === "pending" && (
          <>
            <button
              type="button"
              onClick={() => setStatus(i.id, "scheduled")}
              className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              + Add to plan
            </button>
            <button
              type="button"
              onClick={() => setMarkDoneIdeaId(i.id)}
              className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Mark posted…
            </button>
            <button
              type="button"
              onClick={() => remove(i.id)}
              className="rounded-md px-2.5 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              Dismiss
            </button>
          </>
        )}
        {i.status === "scheduled" && (
          <>
            <button
              type="button"
              onClick={() => setMarkDoneIdeaId(i.id)}
              className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              Mark posted…
            </button>
            <button
              type="button"
              onClick={() => setStatus(i.id, "pending")}
              className="rounded-md px-2.5 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-900"
            >
              Remove from plan
            </button>
          </>
        )}
      </div>
    </>
  );
}

// Sortable wrapper for the Working tab. Provides the grip handle on
// the left + position number + the dnd-kit transform/transition. The
// card body is unchanged so behaviour stays consistent across tabs.
function SortableIdeaCard({
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
          {/* Grid-of-dots glyph — visually unambiguous as a drag affordance */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="4" cy="3" r="1.2" />
            <circle cx="10" cy="3" r="1.2" />
            <circle cx="4" cy="7" r="1.2" />
            <circle cx="10" cy="7" r="1.2" />
            <circle cx="4" cy="11" r="1.2" />
            <circle cx="10" cy="11" r="1.2" />
          </svg>
        </button>
        <span className="font-mono text-[11px] font-medium text-neutral-500">
          {position}
        </span>
      </div>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </article>
  );
}

function ViralityRow({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 text-sm leading-none">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
          {label}
        </div>
        <div className="text-xs text-neutral-800 dark:text-neutral-200">
          {value}
        </div>
      </div>
    </div>
  );
}

function ViralityStrip({ i }: { i: VideoIdeaRow }) {
  const chips: { icon: string; label: string }[] = [];
  if (i.optimal_post_window) {
    chips.push({ icon: "🕒", label: i.optimal_post_window });
  }
  if (i.suggested_duration) {
    chips.push({ icon: "⏱", label: i.suggested_duration });
  }
  if (i.trending_sound) {
    chips.push({
      icon: "🎵",
      label:
        i.trending_sound.length > 50
          ? i.trending_sound.slice(0, 50) + "…"
          : i.trending_sound,
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c, idx) => (
        <span
          key={idx}
          className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
        >
          <span>{c.icon}</span>
          <span>{c.label}</span>
        </span>
      ))}
    </div>
  );
}

function SourceRefs({ refs }: { refs: Record<string, unknown> | null }) {
  if (!refs || Object.keys(refs).length === 0) return null;
  const items: { label: string; href?: string; text: string }[] = [];
  for (const [key, val] of Object.entries(refs)) {
    if (val == null) continue;
    if (typeof val === "string") {
      const isUrl = val.startsWith("http://") || val.startsWith("https://");
      items.push({
        label: key.replace(/_/g, " "),
        href: isUrl ? val : undefined,
        text: val,
      });
    } else if (Array.isArray(val)) {
      items.push({ label: key.replace(/_/g, " "), text: val.join(", ") });
    }
  }
  if (items.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
      {items.map((it, idx) => (
        <span key={idx}>
          <span className="opacity-70">{it.label}:</span>{" "}
          {it.href ? (
            <a
              href={it.href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline"
            >
              {it.text.length > 50 ? it.text.slice(0, 50) + "…" : it.text}
            </a>
          ) : (
            <span>{it.text}</span>
          )}
        </span>
      ))}
    </div>
  );
}
