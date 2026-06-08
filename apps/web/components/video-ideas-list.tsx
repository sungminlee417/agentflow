"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Settings } from "lucide-react";
import { toast } from "sonner";
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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { MarkDoneModal } from "@/components/mark-done-modal";
import { useConfirm } from "@/components/confirm-dialog";
import { ThumbsDownFeedbackModal } from "@/components/video-ideas/modals/feedback-modal";
import { ImportVideoModal } from "@/components/video-ideas/modals/import-modal";
import { AccountSettingsModal } from "@/components/video-ideas/modals/settings-modal";
import { IdeaDetailModal } from "@/components/video-ideas/modals/detail-modal";
import {
  CompactIdeaCard,
  SortableIdeaCard,
} from "@/components/video-ideas/cards/compact-card";
import { PerformanceBlock } from "@/components/video-ideas/blocks/performance";
import {
  buildCaptionTabs,
  CaptionTabs,
  Section,
} from "@/components/video-ideas/blocks/caption";
import {
  SourceRefs,
  ViralityRow,
} from "@/components/video-ideas/blocks/virality";
import {
  FEEDBACK_REASONS,
  KIND_COLORS,
  KIND_LABELS,
  PLATFORM_LABELS,
  PROVIDER_LABELS,
  VERDICT_COLORS,
  VERDICT_LABELS,
} from "@/components/video-ideas/constants";
import {
  accountTitle,
  cardRatio,
  expiresLabel,
  formatRelative,
  formatUntil,
  isUrgent,
  providerChipClass,
} from "@/components/video-ideas/helpers";
import type {
  AccountGroup as AccountGroupType,
  ActiveGenerationJob as ActiveGenerationJobType,
  IdeasAccount as IdeasAccountType,
  KindFilter,
  LinkableAccount as LinkableAccountType,
  PostedRow as PostedRowType,
  VideoIdeaRow as VideoIdeaRowType,
} from "@/components/video-ideas/types";

// Re-export the shared types so the existing public API
// (`@/components/video-ideas-list`) keeps working — the page
// imports VideoIdeaRow etc. from here.
export type VideoIdeaRow = VideoIdeaRowType;
export type PostedRow = PostedRowType;
export type IdeasAccount = IdeasAccountType;
export type LinkableAccount = LinkableAccountType;
export type ActiveGenerationJob = ActiveGenerationJobType;
export type AccountGroup = AccountGroupType;

// Master /video-ideas page entry point. ONE unified flat feed across
// every connected account, with a single "Refresh all" button that
// fans out one parallel agent run per account. Each card shows a
// platform chip; hovering it reveals the source account label so the
// list itself stays tight (kind + status + title + 1-line hook).
type IdeasSort = "newest" | "oldest" | "expiring";
type PostedSort = "recent_post" | "oldest_post" | "best" | "worst";
type GroupRefreshState = {
  label: string;
  count: number;
  activeJobId: string | null;
  done?: boolean;
  failed?: boolean;
};

export function VideoIdeasList({
  groups,
  linkableAccounts,
  allIdeas,
}: {
  groups: AccountGroup[];
  linkableAccounts: LinkableAccount[];
  allIdeas: VideoIdeaRow[];
}) {
  const router = useRouter();
  const { confirm, dialog: confirmDialog } = useConfirm();

  // Lookup tables built once per render.
  const accountById = useMemo(() => {
    const m = new Map<string, IdeasAccount>();
    for (const g of groups) m.set(g.account.id, g.account);
    return m;
  }, [groups]);

  // The full ideas list — initially server-fetched, then kept in sync
  // with optimistic updates + router.refresh() round-trips.
  const [ideas, setIdeas] = useState<VideoIdeaRow[]>(allIdeas);
  useEffect(() => {
    setIdeas(allIdeas);
  }, [allIdeas]);

  // Global view + filter state. ONE set of tabs, ONE filter bar.
  const [view, setView] = useState<"pending" | "scheduled" | "posted">(
    "pending",
  );
  const [filter, setFilter] = useState<KindFilter>("all");
  const [filterAccountId, setFilterAccountId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [ideasSort, setIdeasSort] = useState<IdeasSort>("newest");
  const [postedSort, setPostedSort] = useState<PostedSort>("recent_post");

  // Modal state.
  const [detailIdeaId, setDetailIdeaId] = useState<string | null>(null);
  const [markDoneIdeaId, setMarkDoneIdeaId] = useState<string | null>(null);
  const [feedbackIdeaId, setFeedbackIdeaId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const detailIdea = useMemo(
    () => ideas.find((i) => i.id === detailIdeaId) ?? null,
    [ideas, detailIdeaId],
  );
  const markDoneIdea = useMemo(
    () => ideas.find((i) => i.id === markDoneIdeaId) ?? null,
    [ideas, markDoneIdeaId],
  );
  const feedbackIdea = useMemo(
    () => ideas.find((i) => i.id === feedbackIdeaId) ?? null,
    [ideas, feedbackIdeaId],
  );

  // Per-account refresh state. Each entry = a currently-active or
  // recently-completed stream for that integration. The aggregate
  // progress strip at the top reads from this Map.
  const [refreshing, setRefreshing] = useState<Map<string, GroupRefreshState>>(
    () => {
      const m = new Map<string, GroupRefreshState>();
      for (const g of groups) {
        if (g.activeJob) {
          m.set(g.account.id, {
            label: g.activeJob.step_label,
            count: g.activeJob.step_count,
            activeJobId: g.activeJob.id,
          });
        }
      }
      return m;
    },
  );
  // Abort controllers per account so a follow-up "Refresh all" while
  // an earlier run is still inflight cleanly cancels the previous fetch.
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());

  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Count picker for the unified Generate button. Default 15 — light
  // enough to fit a single 60s Vercel function, heavy enough that a
  // 4-account user gets ~3-4 per account on average.
  const [generateCount, setGenerateCount] = useState(15);

  // Poll any active job ids that we adopted from server state. This is
  // the safety net for SSE drops: if a stream dies, the job row keeps
  // updating server-side, so we poll on a slow loop.
  useEffect(() => {
    const ids = Array.from(refreshing.values())
      .map((s) => s.activeJobId)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      let anyStillRunning = false;
      for (const id of ids) {
        try {
          const res = await fetch(`/api/video-ideas/jobs/${id}`);
          if (!res.ok) continue;
          const json = (await res.json()) as {
            job?: {
              integration_id: string;
              status: "running" | "done" | "failed";
              step_count: number;
              step_label: string | null;
              generated_count: number | null;
              error: string | null;
            };
          };
          const job = json.job;
          if (!job) continue;
          const acctId = job.integration_id;
          if (job.status === "running") {
            anyStillRunning = true;
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.set(acctId, {
                label: job.step_label ?? "Working…",
                count: job.step_count,
                activeJobId: id,
              });
              return next;
            });
          } else if (job.status === "done") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.delete(acctId);
              return next;
            });
          } else {
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.delete(acctId);
              return next;
            });
            setError(job.error ?? "Generation failed.");
          }
        } catch {
          // network blip — try again next tick
          anyStillRunning = true;
        }
      }
      if (anyStillRunning) {
        timer = setTimeout(poll, 2500);
      } else {
        router.refresh();
      }
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount; SSE updates Map directly afterwards

  // Stat buckets.
  const pendingIdeas = useMemo(
    () => ideas.filter((i) => i.status === "pending"),
    [ideas],
  );
  const scheduledIdeas = useMemo(
    () =>
      ideas
        .filter((i) => i.status === "scheduled")
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
    // Multi-target ideas appear under EVERY account chip they target,
    // not just the primary. So filtering by an account chip shows
    // single-target ideas for that account AND multi-target ideas
    // that include it.
    const byAccount = filterAccountId
      ? base.filter((i) =>
          (i.target_integration_ids ?? []).includes(filterAccountId),
        )
      : base;
    const byKind =
      filter === "all"
        ? byAccount
        : byAccount.filter((i) => i.kind === filter);
    if (view === "scheduled") return byKind;
    if (view === "pending") {
      if (ideasSort === "newest") return byKind;
      const sorted = [...byKind];
      if (ideasSort === "oldest") {
        sorted.sort(
          (a, b) =>
            new Date(a.created_at).getTime() -
            new Date(b.created_at).getTime(),
        );
      } else if (ideasSort === "expiring") {
        sorted.sort(
          (a, b) =>
            new Date(a.expires_at).getTime() -
            new Date(b.expires_at).getTime(),
        );
      }
      return sorted;
    }
    if (postedSort === "recent_post") return byKind;
    const sorted = [...byKind];
    if (postedSort === "oldest_post") {
      sorted.sort((a, b) => {
        const aT = new Date(a.posted_at ?? a.created_at).getTime();
        const bT = new Date(b.posted_at ?? b.created_at).getTime();
        return aT - bT;
      });
    } else if (postedSort === "best") {
      sorted.sort(
        (a, b) => (cardRatio(b) ?? -1) - (cardRatio(a) ?? -1),
      );
    } else if (postedSort === "worst") {
      sorted.sort((a, b) => {
        const ar = cardRatio(a);
        const br = cardRatio(b);
        if (ar == null && br == null) return 0;
        if (ar == null) return 1;
        if (br == null) return -1;
        return ar - br;
      });
    }
    return sorted;
  }, [view, baseForView, filter, ideasSort, postedSort, filterAccountId]);

  // Per-account counts for the chip row. Reads from the active view's
  // base so the badge reflects what's currently visible. Multi-target
  // ideas increment every target's count (so a guitar idea targeting
  // both Sungmin TT and Sungmin YT shows up under BOTH chips).
  const accountCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.account.id, 0);
    for (const i of baseForView(view)) {
      const targets = i.target_integration_ids ?? [];
      const seen = new Set<string>();
      for (const t of targets) {
        if (seen.has(t)) continue;
        seen.add(t);
        m.set(t, (m.get(t) ?? 0) + 1);
      }
    }
    return m;
  }, [groups, baseForView, view]);

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

  // dnd-kit sensors for the Working-on tab.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Drag-reorder scopes priority per-account so the queue stays
  // coherent even when ideas from multiple accounts are shown together.
  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const fromIdx = scheduledIdeas.findIndex((i) => i.id === active.id);
    const toIdx = scheduledIdeas.findIndex((i) => i.id === over.id);
    if (fromIdx === -1 || toIdx === -1) return;
    const reordered = arrayMove(scheduledIdeas, fromIdx, toIdx);
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
      if (newPriority === prevPriority) newPriority = prevPriority + 1;
    }
    setIdeas((rows) =>
      rows.map((r) =>
        r.id === moved.id ? { ...r, priority: newPriority } : r,
      ),
    );
    const res = await fetch(`/api/video-ideas/${moved.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ priority: newPriority }),
    });
    if (!res.ok) {
      setIdeas((rows) =>
        rows.map((r) =>
          r.id === moved.id ? { ...r, priority: moved.priority } : r,
        ),
      );
      setError("Couldn't save the new order. Try again.");
    }
  }

  async function runReviewNow(id: string, postId?: string) {
    setReviewingId(postId ?? id);
    setError(null);
    const startToast = toast.loading("Pulling fresh stats + writing review…");
    try {
      const url = postId
        ? `/api/video-ideas/${id}/review?post_id=${encodeURIComponent(postId)}`
        : `/api/video-ideas/${id}/review`;
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        const text = await res.text();
        const msg = `Review failed: ${text.slice(0, 200)}`;
        setError(msg);
        toast.error(msg, { id: startToast });
        return;
      }
      const json = (await res.json().catch(() => null)) as {
        verdict?: string;
        stats?: { ratio?: number };
        reviews?: Array<{ verdict?: string; ratio?: number }>;
      } | null;
      // The /[id]/review route returns either {verdict, stats} for a
      // single-post or legacy review, or {reviews:[...]} for an
      // all-posts pass. Surface whichever applies.
      let summary = "Review refreshed.";
      if (json?.verdict) {
        summary = `Review refreshed — ${json.verdict}${
          json.stats?.ratio != null && json.verdict !== "too_early"
            ? ` (${json.stats.ratio.toFixed(2)}×)`
            : ""
        }.`;
      } else if (json?.reviews && json.reviews.length > 0) {
        const ratios = json.reviews
          .map((r) => r.ratio)
          .filter((r): r is number => typeof r === "number");
        const avg = ratios.length
          ? ratios.reduce((a, b) => a + b, 0) / ratios.length
          : null;
        summary = `Review refreshed across ${json.reviews.length} platform${json.reviews.length === 1 ? "" : "s"}${avg != null ? ` — avg ${avg.toFixed(2)}×` : ""}.`;
      }
      toast.success(summary, { id: startToast });
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(msg, { id: startToast });
    } finally {
      setReviewingId(null);
    }
  }

  async function setStatus(id: string, status: VideoIdeaRow["status"]) {
    const prev = ideas;
    const title = prev.find((r) => r.id === id)?.title ?? "Idea";
    const wasOnIdeas = view === "pending";
    setIdeas((rows) => rows.map((r) => (r.id === id ? { ...r, status } : r)));
    const res = await fetch(`/api/video-ideas/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) {
      setIdeas(prev);
      toast.error(`Update failed (${res.status}).`);
      return;
    }
    router.refresh();
    if (status === "scheduled" && wasOnIdeas) {
      toast.success(`Added to plan — ${title.slice(0, 60)}`, {
        action: {
          label: "View Working on",
          onClick: () => setView("scheduled"),
        },
      });
    } else if (status === "pending" && view === "scheduled") {
      toast.success("Moved back to Ideas.");
    }
  }

  async function remove(id: string) {
    const prev = ideas;
    setIdeas((rows) => rows.filter((r) => r.id !== id));
    const res = await fetch(`/api/video-ideas/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setIdeas(prev);
      toast.error(`Delete failed (${res.status}).`);
      return;
    }
    router.refresh();
  }

  async function deletePosted(id: string) {
    const idea = ideas.find((r) => r.id === id);
    if (!idea) return;
    const ok = await confirm({
      title: `Delete ${idea.title.slice(0, 60)}?`,
      description: idea.performance_review
        ? "This permanently removes the idea, the linked video, and the post-mortem review. Future generations lose this signal."
        : "This permanently removes the idea and any linked posting info.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    await remove(id);
    toast.success("Deleted.");
  }

  // Refresh a single account — kicks off the SSE stream, updates the
  // per-account slot in the refreshing Map as progress arrives. Used
  // both by "Refresh all" (fired in parallel) and on its own if we
  // ever want per-account refresh (e.g. retry on failure).
  async function refreshOne(integrationId: string): Promise<void> {
    setError(null);
    setMessage(null);
    abortControllersRef.current.get(integrationId)?.abort();
    const controller = new AbortController();
    abortControllersRef.current.set(integrationId, controller);
    setRefreshing((prev) => {
      const next = new Map(prev);
      next.set(integrationId, {
        label: "Starting…",
        count: 0,
        activeJobId: null,
      });
      return next;
    });
    try {
      const res = await fetch("/api/video-ideas/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration_id: integrationId }),
        signal: controller.signal,
      });
      if (res.status === 409) {
        const json = (await res.json().catch(() => ({}))) as {
          job_id?: string;
          error?: string;
        };
        if (json.job_id) {
          setRefreshing((prev) => {
            const next = new Map(prev);
            next.set(integrationId, {
              label: "Resuming…",
              count: 0,
              activeJobId: json.job_id!,
            });
            return next;
          });
        } else {
          setRefreshing((prev) => {
            const next = new Map(prev);
            next.delete(integrationId);
            return next;
          });
        }
        return;
      }
      if (!res.ok || !res.body) {
        setRefreshing((prev) => {
          const next = new Map(prev);
          next.delete(integrationId);
          return next;
        });
        setError(`Refresh failed (${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) return;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
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
            if (typeof payload.id === "string") {
              const jid = payload.id;
              setRefreshing((prev) => {
                const next = new Map(prev);
                const cur = next.get(integrationId);
                next.set(integrationId, {
                  label: cur?.label ?? "Working…",
                  count: cur?.count ?? 0,
                  activeJobId: jid,
                });
                return next;
              });
            }
          } else if (evtType === "prepare") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              const cur = next.get(integrationId);
              next.set(integrationId, {
                label: String(payload.label ?? "Working…"),
                count: cur?.count ?? 0,
                activeJobId: cur?.activeJobId ?? null,
              });
              return next;
            });
          } else if (evtType === "step") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              const cur = next.get(integrationId);
              next.set(integrationId, {
                label: String(payload.label ?? "Working…"),
                count: Number(payload.count ?? cur?.count ?? 0),
                activeJobId: cur?.activeJobId ?? null,
              });
              return next;
            });
          } else if (evtType === "inserting") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              const cur = next.get(integrationId);
              next.set(integrationId, {
                label: "Saving…",
                count: Number(payload.generated ?? cur?.count ?? 0),
                activeJobId: cur?.activeJobId ?? null,
              });
              return next;
            });
          } else if (evtType === "done") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.delete(integrationId);
              return next;
            });
            return;
          } else if (evtType === "error") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.delete(integrationId);
              return next;
            });
            setError(
              typeof payload.error === "string"
                ? payload.error
                : "Refresh failed.",
            );
            return;
          }
        }
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (aborted) return;
      setRefreshing((prev) => {
        const next = new Map(prev);
        next.delete(integrationId);
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Unified generate: one POST → one agent run sees every connected
  // account at once → ideas come back tagged with target_integration_ids.
  // Replaces the old per-account refreshAll loop.
  async function generateAll(totalCount: number) {
    if (groups.length === 0) return;
    setError(null);
    setMessage(null);
    // Use a synthetic key "__all__" for the unified-run progress strip
    // so it sits in the SAME refreshing Map the per-account ↻ uses.
    const KEY = "__all__";
    const controller = new AbortController();
    abortControllersRef.current.get(KEY)?.abort();
    abortControllersRef.current.set(KEY, controller);
    setRefreshing((prev) => {
      const next = new Map(prev);
      next.set(KEY, {
        label: `Generating ${totalCount} ideas across ${groups.length} account${groups.length === 1 ? "" : "s"}…`,
        count: 0,
        activeJobId: null,
      });
      return next;
    });
    try {
      const res = await fetch("/api/video-ideas/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ total_count: totalCount }),
        signal: controller.signal,
      });
      if (res.status === 409) {
        const json = (await res.json().catch(() => ({}))) as {
          job_id?: string;
        };
        setRefreshing((prev) => {
          const next = new Map(prev);
          next.set(KEY, {
            label: "Resuming in-flight generation…",
            count: 0,
            activeJobId: json.job_id ?? null,
          });
          return next;
        });
        return;
      }
      if (!res.ok || !res.body) {
        setRefreshing((prev) => {
          const next = new Map(prev);
          next.delete(KEY);
          return next;
        });
        setError(`Generation failed (${res.status}).`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (controller.signal.aborted) return;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 2);
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
            const jid = typeof payload.id === "string" ? payload.id : null;
            if (jid) {
              setRefreshing((prev) => {
                const next = new Map(prev);
                const cur = next.get(KEY);
                next.set(KEY, {
                  label: cur?.label ?? "Working…",
                  count: cur?.count ?? 0,
                  activeJobId: jid,
                });
                return next;
              });
            }
          } else if (evtType === "prepare" || evtType === "step") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              const cur = next.get(KEY);
              next.set(KEY, {
                label: String(payload.label ?? cur?.label ?? "Working…"),
                count: Number(payload.count ?? cur?.count ?? 0),
                activeJobId: cur?.activeJobId ?? null,
              });
              return next;
            });
          } else if (evtType === "inserting") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              const cur = next.get(KEY);
              next.set(KEY, {
                label: "Saving…",
                count: Number(payload.generated ?? cur?.count ?? 0),
                activeJobId: cur?.activeJobId ?? null,
              });
              return next;
            });
          } else if (evtType === "done") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.delete(KEY);
              return next;
            });
            const generated = Number(payload.generated ?? 0);
            setMessage(
              generated > 0
                ? `Generated ${generated} new idea${generated === 1 ? "" : "s"}.`
                : "No new ideas — current set is fresh.",
            );
            router.refresh();
            return;
          } else if (evtType === "error") {
            setRefreshing((prev) => {
              const next = new Map(prev);
              next.delete(KEY);
              return next;
            });
            setError(
              typeof payload.error === "string"
                ? payload.error
                : "Generation failed.",
            );
            return;
          }
        }
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === "AbortError";
      if (aborted) return;
      setRefreshing((prev) => {
        const next = new Map(prev);
        next.delete("__all__");
        return next;
      });
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const totalActive = refreshing.size;
  const isRefreshing = totalActive > 0;

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700">
          <h2 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
            Connect an account to get started
          </h2>
          <p className="mt-2 text-sm text-neutral-500">
            Link a TikTok, YouTube, or Instagram account — the agent reads
            your top performers, your niche, and what&apos;s breaking out
            right now to generate ideas tailored to you.
          </p>
          <Link
            href="/integrations"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Connect an account →
          </Link>
          <p className="mt-4 text-xs text-neutral-500">
            Once connected, hit <span className="font-medium">Refresh all</span>{" "}
            in the header to generate your first batch.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-8 md:py-10">
      <header className="flex flex-wrap items-center justify-between gap-3 pl-10 md:pl-0">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            Video ideas
          </h1>
          <Link
            href="/integrations"
            className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            +
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            title="Review an existing video from your back catalogue"
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Import
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Per-account targets, preferences, and quick-add"
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            Settings
          </button>
          <select
            value={generateCount}
            onChange={(e) => setGenerateCount(Number(e.target.value))}
            disabled={isRefreshing}
            title="How many ideas to generate"
            aria-label="Idea count"
            className="rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
          >
            {[5, 10, 15, 20, 25, 30].map((n) => (
              <option key={n} value={n}>
                {n} ideas
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => generateAll(generateCount)}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            {isRefreshing ? "Generating…" : "Generate"}
          </button>
        </div>
      </header>

      {/* Account chips. Click one to scope the feed to a single
       *  account; click again to clear. Counts reflect the active
       *  view's bucket (Ideas / Working on / Posted). */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {groups.map((g) => {
          const acct = g.account;
          const count = accountCounts.get(acct.id) ?? 0;
          const active = filterAccountId === acct.id;
          const chipClass = providerChipClass(acct.provider);
          return (
            <button
              key={acct.id}
              type="button"
              onClick={() =>
                setFilterAccountId(active ? null : acct.id)
              }
              title={accountTitle(acct)}
              // Always reserve a 2px inset ring slot — color it neutral
              // when active, transparent otherwise. Without this the
              // active-only `ring-2` ate part of the chip-row gap on
              // one side only, creating asymmetric visual rhythm
              // against neighbours that read as CLS.
              className={`group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-2 ring-inset transition ${
                active
                  ? "ring-neutral-900 dark:ring-neutral-100"
                  : "ring-transparent hover:brightness-95 dark:hover:brightness-110"
              } ${chipClass}`}
            >
              <span className="font-semibold uppercase tracking-wide">
                {PROVIDER_LABELS[acct.provider] ?? acct.provider}
              </span>
              <span className="opacity-75">{accountTitle(acct)}</span>
              <span className="rounded-full bg-white/60 px-1.5 text-[10px] font-semibold tabular-nums text-neutral-900 dark:bg-black/30 dark:text-neutral-100">
                {count}
              </span>
            </button>
          );
        })}
        {/* Clear-filter affordance is the active chip itself — click
         *  again to clear. Adding a separate "Clear filter" button into
         *  this flex-wrap row caused CLS because it only mounted when
         *  filterAccountId was truthy, pushing the chip row's wrap
         *  layout on every toggle. */}
      </div>

      {isRefreshing && (
        <div className="mt-3 space-y-1 rounded-md border border-neutral-200 bg-neutral-50/60 px-3 py-2 text-xs dark:border-neutral-800 dark:bg-neutral-900/40">
          {Array.from(refreshing.entries()).map(([acctId, state]) => {
            const acct = accountById.get(acctId);
            return (
              <div
                key={acctId}
                className="flex items-center justify-between gap-2"
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${providerChipClass(
                      acct?.provider,
                    )}`}
                  >
                    {acct ? PROVIDER_LABELS[acct.provider] ?? acct.provider : "?"}
                  </span>
                  <span className="text-neutral-700 dark:text-neutral-300">
                    {acct ? accountTitle(acct) : acctId}
                  </span>
                </span>
                <span className="text-neutral-500">
                  step {state.count} · {state.label}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900 dark:border-rose-900/60 dark:bg-rose-950/30 dark:text-rose-200">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}
      {message && !error && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          <span>{message}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            aria-label="Dismiss message"
            className="opacity-60 hover:opacity-100"
          >
            ✕
          </button>
        </div>
      )}

      <div className="mt-4 flex items-center gap-1 rounded-md border border-neutral-200 bg-neutral-100/60 p-1 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex flex-wrap gap-2">
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
        {view !== "scheduled" && (
          <label className="flex items-center gap-1.5 text-xs text-neutral-500">
            <span className="hidden sm:inline">Sort</span>
            {view === "pending" ? (
              <select
                value={ideasSort}
                onChange={(e) => setIdeasSort(e.target.value as IdeasSort)}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="expiring">Expiring soonest</option>
              </select>
            ) : (
              <select
                value={postedSort}
                onChange={(e) => setPostedSort(e.target.value as PostedSort)}
                className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                <option value="recent_post">Most recent post</option>
                <option value="oldest_post">Oldest post</option>
                <option value="best">Best performing</option>
                <option value="worst">Worst performing</option>
              </select>
            )}
          </label>
        )}
      </div>

      <section className="mt-4 divide-y divide-neutral-200 rounded-lg border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-950">
        {filtered.length === 0 ? (
          <div className="rounded-lg px-4 py-12 text-center text-sm text-neutral-500">
            {view === "pending" &&
              (pendingIdeas.length === 0 ? (
                <>
                  <p className="font-medium text-neutral-700 dark:text-neutral-200">
                    No ideas yet
                  </p>
                  <p className="mt-1">
                    Hit <span className="font-medium">Refresh all</span> above
                    to generate your first batch — one per connected account.
                  </p>
                </>
              ) : (
                <>
                  <p>No ideas match this filter.</p>
                  {(filter !== "all" || filterAccountId) && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilter("all");
                        setFilterAccountId(null);
                      }}
                      className="mt-2 text-xs text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100"
                    >
                      Clear filters
                    </button>
                  )}
                </>
              ))}
            {view === "scheduled" &&
              (scheduledIdeas.length === 0 ? (
                <>
                  <p className="font-medium text-neutral-700 dark:text-neutral-200">
                    Nothing in your queue
                  </p>
                  <p className="mt-1">
                    Open an idea from the <span className="font-medium">Ideas</span>{" "}
                    tab and hit <span className="font-medium">Add to plan</span> to
                    commit to it.
                  </p>
                </>
              ) : (
                "No queued ideas match this filter."
              ))}
            {view === "posted" &&
              (postedIdeas.length === 0 ? (
                <>
                  <p className="font-medium text-neutral-700 dark:text-neutral-200">
                    Nothing posted yet
                  </p>
                  <p className="mt-1">
                    Once you mark an idea as posted, the agent pulls stats at
                    +48h and +7d and writes a post-mortem here. You can also
                    use <span className="font-medium">Import</span> above to
                    review videos from your back catalogue.
                  </p>
                </>
              ) : (
                "No posted videos match this filter."
              ))}
          </div>
        ) : view === "scheduled" ? (
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
                <SortableIdeaCard key={i.id} id={i.id} position={idx + 1}>
                  <CompactIdeaCard
                    i={i}
                    account={
                      i.integration_id
                        ? accountById.get(i.integration_id) ?? null
                        : null
                    }
                    targets={(i.target_integration_ids ?? [])
                      .map((id) => accountById.get(id) ?? null)
                      .filter((a): a is NonNullable<typeof a> => !!a)}
                    onOpen={() => setDetailIdeaId(i.id)}
                    onThumbsDown={() => setFeedbackIdeaId(i.id)}
                  />
                </SortableIdeaCard>
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          filtered.map((i) => (
            <CompactIdeaCard
              key={i.id}
              i={i}
              account={
                i.integration_id
                  ? accountById.get(i.integration_id) ?? null
                  : null
              }
              targets={(i.target_integration_ids ?? [])
                .map((id) => accountById.get(id) ?? null)
                .filter((a): a is NonNullable<typeof a> => !!a)}
              onOpen={() => setDetailIdeaId(i.id)}
              onThumbsDown={() => setFeedbackIdeaId(i.id)}
            />
          ))
        )}
      </section>

      <AccountSettingsModal
        open={settingsOpen}
        groups={groups}
        onClose={() => setSettingsOpen(false)}
      />

      <ImportVideoModal
        open={importOpen}
        groups={groups}
        onClose={() => setImportOpen(false)}
        onImported={(msg) => {
          setImportOpen(false);
          setMessage(msg);
          router.refresh();
        }}
      />

      <MarkDoneModal
        open={markDoneIdeaId !== null}
        ideaId={markDoneIdeaId}
        ideaTitle={markDoneIdea?.title ?? null}
        targets={linkableAccounts.map((a) => ({
          id: a.id,
          platform: a.platform,
          label: a.label,
          isSource: a.id === markDoneIdea?.integration_id,
        }))}
        onClose={() => setMarkDoneIdeaId(null)}
        onLinked={() => {
          router.refresh();
          setMessage("Marked as posted. First review in ~48h.");
        }}
      />

      <ThumbsDownFeedbackModal
        open={feedbackIdeaId !== null}
        ideaId={feedbackIdeaId}
        ideaTitle={feedbackIdea?.title ?? null}
        onClose={() => setFeedbackIdeaId(null)}
        onSubmitted={() => {
          if (feedbackIdeaId) {
            setIdeas((rows) => rows.filter((r) => r.id !== feedbackIdeaId));
          }
          setFeedbackIdeaId(null);
          toast.success("Thanks — the next refresh will avoid this pattern.");
          router.refresh();
        }}
      />

      {detailIdea && (
        <IdeaDetailModal
          idea={detailIdea}
          account={
            detailIdea.integration_id
              ? accountById.get(detailIdea.integration_id) ?? null
              : null
          }
          targets={(detailIdea.target_integration_ids ?? [])
            .map((id) => accountById.get(id) ?? null)
            .filter((a): a is NonNullable<typeof a> => !!a)}
          reviewingId={reviewingId}
          onClose={() => setDetailIdeaId(null)}
          onSchedule={() => {
            setStatus(detailIdea.id, "scheduled");
            setDetailIdeaId(null);
          }}
          onDone={() => {
            setMarkDoneIdeaId(detailIdea.id);
            setDetailIdeaId(null);
          }}
          onUnschedule={() => {
            setStatus(detailIdea.id, "pending");
            setDetailIdeaId(null);
          }}
          onDismiss={() => {
            remove(detailIdea.id);
            setDetailIdeaId(null);
          }}
          onThumbsDown={() => {
            setFeedbackIdeaId(detailIdea.id);
            setDetailIdeaId(null);
          }}
          onDeletePosted={() => {
            void deletePosted(detailIdea.id);
            setDetailIdeaId(null);
          }}
          onReview={(postId) => {
            void runReviewNow(detailIdea.id, postId);
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}



