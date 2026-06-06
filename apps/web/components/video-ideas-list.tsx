"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Clock,
  GripVertical,
  Image as ImageIcon,
  MessageCircle,
  Music,
  Settings,
  Timer,
  type LucideIcon,
} from "lucide-react";
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
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Modal } from "@/components/modal";
import { MarkDoneModal } from "@/components/mark-done-modal";
import { QuickAddIdea } from "@/components/quick-add-idea";
import { AccountPreferences } from "@/components/account-preferences";
import { useConfirm } from "@/components/confirm-dialog";

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
    /** True when this stats blob is the cross-platform synthesis
     *  aggregate (totals across all platforms + average ratio) rather
     *  than the legacy single-post stats. */
    cross_platform?: boolean;
    platform_count?: number;
  } | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  /** Per-platform posts. Multi-row when the same shoot landed on more
   *  than one platform (TikTok + YT Shorts + IG Reels). Empty array
   *  for ideas that haven't been marked posted yet. */
  posts?: PostedRow[];
  /** Per-platform caption packaging produced by the generator. Only
   *  the platforms the user has connected are populated; legacy ideas
   *  pre-Phase-3 have this null and fall back to post_title /
   *  description / hashtags. */
  platforms?: {
    tiktok?: { caption: string; hashtags: string[] };
    youtube?: { title: string; description: string; hashtags: string[] };
    instagram?: { caption: string; hashtags: string[] };
  } | null;
};

export type PostedRow = {
  id: string;
  integration_id: string;
  platform: string;
  posted_video_id: string;
  posted_video_url: string | null;
  posted_at: string;
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

export type LinkableAccount = {
  id: string;
  platform: string;
  label: string;
};

export type ActiveGenerationJob = {
  id: string;
  step_count: number;
  step_label: string;
  requested_count: number | null;
  started_at: string;
};

// One account's bundle of data on the master /video-ideas page. Each
// account (= each connected TT/YT/IG integration) gets its own section
// in the unified feed. The agent generates ideas natively for the
// account's own platform — no cross-pack at generation time — and the
// section renders a compact card grid for that account's ideas.
export type AccountGroup = {
  account: IdeasAccount;
  ideas: VideoIdeaRow[];
  targetCount: number;
  preferences: string | null;
  activeJob: ActiveGenerationJob | null;
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
  const [ideasSort, setIdeasSort] = useState<IdeasSort>("newest");
  const [postedSort, setPostedSort] = useState<PostedSort>("recent_post");

  // Modal state.
  const [detailIdeaId, setDetailIdeaId] = useState<string | null>(null);
  const [markDoneIdeaId, setMarkDoneIdeaId] = useState<string | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const detailIdea = useMemo(
    () => ideas.find((i) => i.id === detailIdeaId) ?? null,
    [ideas, detailIdeaId],
  );
  const markDoneIdea = useMemo(
    () => ideas.find((i) => i.id === markDoneIdeaId) ?? null,
    [ideas, markDoneIdeaId],
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
    const byAccount = filterAccountId
      ? base.filter((i) => i.integration_id === filterAccountId)
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
        (a, b) =>
          (b.performance_stats?.ratio ?? -1) -
          (a.performance_stats?.ratio ?? -1),
      );
    } else if (postedSort === "worst") {
      sorted.sort((a, b) => {
        const ar = a.performance_stats?.ratio;
        const br = b.performance_stats?.ratio;
        if (ar == null && br == null) return 0;
        if (ar == null) return 1;
        if (br == null) return -1;
        return ar - br;
      });
    }
    return sorted;
  }, [view, baseForView, filter, ideasSort, postedSort, filterAccountId]);

  // Per-account pending counts for the chip row. Reads from the
  // active view's base so the badge reflects what's currently
  // visible (e.g. when on Posted tab, the chip count is posted, not
  // pending). Sums by integration_id so accounts with zero ideas
  // still render with a 0.
  const accountCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.account.id, 0);
    for (const i of baseForView(view)) {
      if (!i.integration_id) continue;
      m.set(i.integration_id, (m.get(i.integration_id) ?? 0) + 1);
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
    try {
      const url = postId
        ? `/api/video-ideas/${id}/review?post_id=${encodeURIComponent(postId)}`
        : `/api/video-ideas/${id}/review`;
      const res = await fetch(url, { method: "POST" });
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

  // Fire one refreshOne per connected account in parallel and refresh
  // the page when they all settle.
  async function refreshAll() {
    if (groups.length === 0) return;
    await Promise.all(groups.map((g) => refreshOne(g.account.id)));
    router.refresh();
    setMessage("Generation complete.");
  }

  const totalActive = refreshing.size;
  const isRefreshing = totalActive > 0;

  if (groups.length === 0) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
        <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-14 text-center dark:border-neutral-700">
          <h2 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
            No accounts connected
          </h2>
          <p className="mt-2 text-sm text-neutral-500">
            Connect a TikTok, YouTube, or Instagram account to start
            generating ideas tailored to it.
          </p>
          <Link
            href="/integrations"
            className="mt-4 inline-block rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Connect an account
          </Link>
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
            onClick={() => setSettingsOpen(true)}
            title="Per-account targets, preferences, and quick-add"
            className="inline-flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
            Settings
          </button>
          <button
            type="button"
            onClick={refreshAll}
            disabled={isRefreshing}
            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            {isRefreshing
              ? `Refreshing ${totalActive}/${groups.length}…`
              : `Refresh all`}
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
          const chipClass =
            acct.provider === "tiktok"
              ? "bg-pink-100 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200"
              : acct.provider === "youtube"
                ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200"
                : "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-200";
          return (
            <button
              key={acct.id}
              type="button"
              onClick={() =>
                setFilterAccountId(active ? null : acct.id)
              }
              title={accountTitle(acct)}
              className={`group inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                active
                  ? "ring-2 ring-neutral-900 dark:ring-neutral-100"
                  : "hover:brightness-95 dark:hover:brightness-110"
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
        {filterAccountId && (
          <button
            type="button"
            onClick={() => setFilterAccountId(null)}
            className="rounded-full border border-neutral-300 px-2.5 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Clear filter
          </button>
        )}
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
                    className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      acct?.provider === "tiktok"
                        ? "bg-pink-100 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200"
                        : acct?.provider === "youtube"
                          ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200"
                          : "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-200"
                    }`}
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
          <div className="rounded-lg px-4 py-10 text-center text-sm text-neutral-500">
            {view === "pending" &&
              (pendingIdeas.length === 0
                ? "No ideas yet. Hit Refresh all to generate the first batch."
                : "No ideas match this filter.")}
            {view === "scheduled" &&
              (scheduledIdeas.length === 0
                ? "Nothing in your queue. Pick an idea and Add to plan."
                : "No queued ideas match this filter.")}
            {view === "posted" &&
              (postedIdeas.length === 0
                ? "Nothing posted yet."
                : "No posted videos match this filter.")}
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
                    onOpen={() => setDetailIdeaId(i.id)}
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
              onOpen={() => setDetailIdeaId(i.id)}
            />
          ))
        )}
      </section>

      <AccountSettingsModal
        open={settingsOpen}
        groups={groups}
        onClose={() => setSettingsOpen(false)}
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

      {detailIdea && (
        <IdeaDetailModal
          idea={detailIdea}
          account={
            detailIdea.integration_id
              ? accountById.get(detailIdea.integration_id) ?? null
              : null
          }
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

// Per-account settings modal. One section per connected integration,
// each with: target_count input (top up to N ideas), preferences
// textarea (free-text guidance fed to the agent prompt), and a
// quick-add input ("I have an idea: …"). Reuses the existing
// AccountPreferences + QuickAddIdea components so behavior stays
// consistent with what users saw on the per-account page pre-flat.
function AccountSettingsModal({
  open,
  groups,
  onClose,
}: {
  open: boolean;
  groups: AccountGroup[];
  onClose: () => void;
}) {
  // Local mirror of target_count per account, so the stepper feels
  // snappy. Saves on blur / Enter.
  const [targets, setTargets] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const g of groups) m.set(g.account.id, g.targetCount);
    return m;
  });
  useEffect(() => {
    setTargets(() => {
      const m = new Map<string, number>();
      for (const g of groups) m.set(g.account.id, g.targetCount);
      return m;
    });
  }, [groups]);

  async function saveTarget(accountId: string, value: number) {
    const clamped = Math.max(1, Math.min(50, Math.round(value)));
    setTargets((prev) => {
      const next = new Map(prev);
      next.set(accountId, clamped);
      return next;
    });
    await fetch("/api/video-ideas/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        integration_id: accountId,
        target_count: clamped,
      }),
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      subtitle="Per-account targets, preferences, and quick-add ideas"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-6">
        {groups.map((g) => {
          const acct = g.account;
          const target = targets.get(acct.id) ?? g.targetCount;
          const chipClass =
            acct.provider === "tiktok"
              ? "bg-pink-100 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200"
              : acct.provider === "youtube"
                ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200"
                : "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-200";
          return (
            <details
              key={acct.id}
              open={groups.length === 1}
              className="rounded-lg border border-neutral-200 dark:border-neutral-800"
            >
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-sm font-medium text-neutral-900 dark:text-neutral-100">
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chipClass}`}
                >
                  {PROVIDER_LABELS[acct.provider] ?? acct.provider}
                </span>
                <span className="truncate">{accountTitle(acct)}</span>
              </summary>
              <div className="space-y-4 border-t border-neutral-200 px-3 py-4 dark:border-neutral-800">
                <div>
                  <label className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-neutral-700 dark:text-neutral-300">
                      Target ideas
                      <span className="ml-1 text-neutral-500">
                        — Refresh fills up to this many pending ideas
                      </span>
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={target}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (Number.isFinite(n)) {
                          setTargets((prev) => {
                            const next = new Map(prev);
                            next.set(acct.id, n);
                            return next;
                          });
                        }
                      }}
                      onBlur={(e) => saveTarget(acct.id, Number(e.target.value))}
                      className="w-16 rounded-md border border-neutral-300 bg-white px-2 py-1 text-right text-xs text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                    />
                  </label>
                </div>
                <AccountPreferences
                  selectedAccountId={acct.id}
                  initial={g.preferences}
                />
                <QuickAddIdea selectedAccountId={acct.id} />
              </div>
            </details>
          );
        })}
      </div>
    </Modal>
  );
}

function IdeaDetailModal({
  idea,
  account,
  reviewingId,
  onClose,
  onSchedule,
  onDone,
  onUnschedule,
  onDismiss,
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

        {captionTabs.length > 0 && <CaptionTabs tabs={captionTabs} />}

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
          <Section title="Source evidence">
            <div className="text-[11px]">
              <SourceRefs refs={idea.source_refs} />
            </div>
          </Section>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <div className="flex flex-wrap gap-2">
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
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Review now
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

type CaptionTab = {
  platform: string; // "tiktok" | "youtube" | "instagram" | "generic"
  label: string;
  title: string | null; // YT-only normally
  body: string | null;
  hashtags: string[];
  // What lands on the clipboard when "Copy caption + tags" is hit —
  // pre-assembled per platform so the user can paste straight in.
  combined: string;
};

function buildCaptionTabs(idea: VideoIdeaRow): CaptionTab[] {
  const out: CaptionTab[] = [];
  const p = idea.platforms ?? null;
  if (p?.tiktok?.caption) {
    const tags = (p.tiktok.hashtags ?? []).map((h) => `#${h}`).join(" ");
    out.push({
      platform: "tiktok",
      label: "TikTok",
      title: null,
      body: p.tiktok.caption,
      hashtags: p.tiktok.hashtags ?? [],
      combined: [p.tiktok.caption, tags].filter(Boolean).join("\n\n").trim(),
    });
  }
  if (p?.youtube?.title) {
    const tags = (p.youtube.hashtags ?? []).map((h) => `#${h}`).join(" ");
    out.push({
      platform: "youtube",
      label: "YouTube Shorts",
      title: p.youtube.title,
      body: p.youtube.description ?? null,
      hashtags: p.youtube.hashtags ?? [],
      combined: [p.youtube.title, p.youtube.description, tags]
        .filter(Boolean)
        .join("\n\n")
        .trim(),
    });
  }
  if (p?.instagram?.caption) {
    const tags = (p.instagram.hashtags ?? []).map((h) => `#${h}`).join(" ");
    out.push({
      platform: "instagram",
      label: "Instagram Reels",
      title: null,
      body: p.instagram.caption,
      hashtags: p.instagram.hashtags ?? [],
      combined: [p.instagram.caption, tags].filter(Boolean).join("\n\n").trim(),
    });
  }
  // Legacy fallback: ideas generated before the platforms column
  // existed get one generic tab assembled from post_title / description
  // / hashtags so the modal isn't suddenly empty for them.
  if (out.length === 0 && (idea.post_title || idea.description)) {
    const tags = (idea.hashtags ?? []).map((h) => `#${h}`).join(" ");
    const body = [idea.post_title, idea.description]
      .filter((x) => !!x)
      .join("\n\n");
    out.push({
      platform: "generic",
      label: "Caption",
      title: idea.post_title,
      body: idea.description,
      hashtags: idea.hashtags ?? [],
      combined: [body, tags].filter(Boolean).join("\n\n").trim(),
    });
  }
  return out;
}

function CaptionTabs({ tabs }: { tabs: CaptionTab[] }) {
  const [active, setActive] = useState(0);
  // If the tab set shrinks (e.g. user dismisses + new idea opens), keep
  // active in bounds without forcing a clamp on every render.
  const safeActive = Math.min(active, tabs.length - 1);
  const tab = tabs[safeActive]!;
  const showTabs = tabs.length > 1;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Caption
          </h3>
          {showTabs && (
            <div className="flex gap-1">
              {tabs.map((t, i) => (
                <button
                  key={t.platform}
                  type="button"
                  onClick={() => setActive(i)}
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium transition ${
                    i === safeActive
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <CopyButton text={tab.combined} label="Copy caption + tags" />
      </div>
      <div className="rounded-md bg-neutral-50 px-3 py-3 text-sm text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
        {tab.title && <p className="font-medium">{tab.title}</p>}
        {tab.body && (
          <p
            className={`whitespace-pre-wrap ${tab.title ? "mt-2" : ""}`}
          >
            {tab.body}
          </p>
        )}
        {tab.hashtags.length > 0 && (
          <p className="mt-3 text-blue-700 dark:text-blue-300">
            {tab.hashtags.map((h) => `#${h}`).join(" ")}
          </p>
        )}
      </div>
    </div>
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

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  instagram: "Instagram",
};

function PerformanceBlock({
  i,
  reviewingId,
  onReview,
}: {
  i: VideoIdeaRow;
  reviewingId: string | null;
  onReview: (postId?: string) => void;
}) {
  // Prefer the new per-platform posts list; fall back to the
  // denormalised single-post columns on the idea row for ideas that
  // haven't been re-linked since the multi-platform migration.
  const posts = i.posts ?? [];
  if (posts.length > 0) {
    // Cross-platform synthesis: lives on the idea row when 2+ posts
    // settled and the worker (or "Review now" all) wrote a synthesis.
    // performance_stats.cross_platform marks it so we don't confuse it
    // with the legacy single-post performance_review.
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

  // Legacy single-post render — preserved for backward compat. Once
  // the migration backfills every idea, this branch becomes dead
  // code we can delete.
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

// Compact card — clickable header that opens the detail modal.
// Everything substantive (script, captions, virality breakdown, action
// buttons) lives in the modal; the card itself is a kind chip + status
// signal + title + 1-line hook tease. Mirrors what the user can scan in
// a master feed without having to expand every card.
function CompactIdeaCard({
  i,
  account,
  onOpen,
}: {
  i: VideoIdeaRow;
  account: IdeasAccount | null;
  onOpen: () => void;
}) {
  const verdict = i.performance_verdict;
  const ratio = i.performance_stats?.ratio;
  const ready =
    !!i.script ||
    !!i.description ||
    (i.hashtags?.length ?? 0) > 0 ||
    !!i.platforms?.tiktok ||
    !!i.platforms?.youtube ||
    !!i.platforms?.instagram;
  // Platform chip + tooltip reveal the source account on hover. Keeps
  // the row visually quiet (a single chip, not a whole account label)
  // while still letting the user disambiguate when they have multiple
  // accounts on the same platform.
  const platform = (i.provider ?? account?.provider ?? "").toLowerCase();
  const platformLabel = PLATFORM_LABELS[platform] ?? PROVIDER_LABELS[platform] ?? platform;
  const platformClass =
    platform === "tiktok"
      ? "bg-pink-100 text-pink-800 dark:bg-pink-950/40 dark:text-pink-200"
      : platform === "youtube"
        ? "bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-200"
        : "bg-purple-100 text-purple-800 dark:bg-purple-950/40 dark:text-purple-200";
  const accountLabel = account ? accountTitle(account) : "Unknown account";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full px-4 py-3 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-900/60"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-semibold ${platformClass}`}
          title={accountLabel}
        >
          {platformLabel}
        </span>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${KIND_COLORS[i.kind]}`}
        >
          {KIND_LABELS[i.kind]}
        </span>
        {i.status === "done" && verdict && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 font-medium ${VERDICT_COLORS[verdict]}`}
          >
            {VERDICT_LABELS[verdict]}
            {ratio != null && verdict !== "too_early" && (
              <span className="ml-1 opacity-75">· {ratio.toFixed(2)}×</span>
            )}
          </span>
        )}
        {i.status === "done" && !verdict && (
          <span className="rounded-full bg-neutral-100 px-2 py-0.5 font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
            Review pending
          </span>
        )}
        {i.status !== "done" && i.status !== "scheduled" && (
          <span
            className={
              isUrgent(i.expires_at)
                ? "text-rose-600 dark:text-rose-400"
                : "text-neutral-500"
            }
          >
            {expiresLabel(i.expires_at)}
          </span>
        )}
        {i.saturation_warning && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
            Saturated
          </span>
        )}
        {ready && i.status === "pending" && (
          <span className="ml-auto inline-flex items-center rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
            Upload-ready
          </span>
        )}
      </div>
      <p className="mt-1.5 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
        {i.title}
      </p>
      {i.hook && (
        <p className="mt-1 line-clamp-1 text-xs text-neutral-500">
          {i.hook}
        </p>
      )}
    </button>
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
  deletePosted,
}: {
  i: VideoIdeaRow;
  reviewingId: string | null;
  runReviewNow: (id: string, postId?: string) => void;
  setDetailIdeaId: (id: string) => void;
  setStatus: (id: string, status: VideoIdeaRow["status"]) => void;
  setMarkDoneIdeaId: (id: string) => void;
  remove: (id: string) => void;
  deletePosted: (id: string) => void;
}) {
  const hasFullContent =
    !!i.script ||
    !!i.description ||
    (i.hashtags?.length ?? 0) > 0 ||
    !!i.platforms?.tiktok ||
    !!i.platforms?.youtube ||
    !!i.platforms?.instagram;
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
          <AlertTriangle
            className="mt-0.5 h-3 w-3 shrink-0"
            aria-hidden="true"
          />
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
          reviewingId={reviewingId}
          onReview={(postId) => runReviewNow(i.id, postId)}
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
        {i.status === "done" && (
          <button
            type="button"
            onClick={() => deletePosted(i.id)}
            className="rounded-md px-2.5 py-1 text-xs text-neutral-500 transition hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/30 dark:hover:text-red-400"
          >
            Delete
          </button>
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
          <GripVertical className="h-4 w-4" aria-hidden="true" />
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
  Icon,
  label,
  value,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon
        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500"
        aria-hidden="true"
      />
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
  const chips: { Icon: LucideIcon; label: string }[] = [];
  if (i.optimal_post_window) {
    chips.push({ Icon: Clock, label: i.optimal_post_window });
  }
  if (i.suggested_duration) {
    chips.push({ Icon: Timer, label: i.suggested_duration });
  }
  if (i.trending_sound) {
    chips.push({
      Icon: Music,
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
          <c.Icon className="h-3 w-3" aria-hidden="true" />
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
