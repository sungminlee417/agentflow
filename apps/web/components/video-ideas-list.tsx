"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export type VideoIdeaRow = {
  id: string;
  provider: string;
  title: string;
  hook: string | null;
  format: string | null;
  rationale: string | null;
  kind: "pattern" | "trend" | "competitor" | "seasonal";
  source_refs: Record<string, unknown> | null;
  expires_at: string;
  status: "pending" | "scheduled" | "done" | "dismissed";
  created_at: string;
};

type KindFilter = "all" | VideoIdeaRow["kind"];

const KIND_LABELS: Record<VideoIdeaRow["kind"], string> = {
  pattern: "Pattern",
  trend: "Trend",
  competitor: "Competitor",
  seasonal: "Seasonal",
};

const KIND_COLORS: Record<VideoIdeaRow["kind"], string> = {
  pattern:
    "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  trend: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  competitor:
    "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300",
  seasonal:
    "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
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

export function VideoIdeasList({
  initial,
  targetCount,
  tiktokConnected,
}: {
  initial: VideoIdeaRow[];
  targetCount: number;
  tiktokConnected: boolean;
}) {
  const router = useRouter();
  const [ideas, setIdeas] = useState<VideoIdeaRow[]>(initial);
  const [target, setTarget] = useState(targetCount);
  const [filter, setFilter] = useState<KindFilter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);

  const filtered = useMemo(() => {
    const list = ideas.filter((i) => i.status === "pending");
    if (filter === "all") return list;
    return list.filter((i) => i.kind === filter);
  }, [ideas, filter]);

  async function refresh() {
    if (!tiktokConnected) {
      setError("Connect TikTok in /integrations first.");
      return;
    }
    setRefreshing(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/video-ideas/refresh", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as {
        generated?: number;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(json.error ?? `Refresh failed (${res.status}).`);
        return;
      }
      if (json.generated && json.generated > 0) {
        setMessage(`Generated ${json.generated} new idea${json.generated === 1 ? "" : "s"}.`);
      } else {
        setMessage(json.message ?? "Already at target.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function updateTarget(newTarget: number) {
    setSavingTarget(true);
    try {
      const res = await fetch("/api/video-ideas/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_count: newTarget }),
      });
      if (res.ok) setTarget(newTarget);
    } finally {
      setSavingTarget(false);
    }
  }

  async function setStatus(id: string, status: VideoIdeaRow["status"]) {
    // Optimistic
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

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, pattern: 0, trend: 0, competitor: 0, seasonal: 0 };
    for (const i of ideas) {
      if (i.status !== "pending") continue;
      c["all"] = (c["all"] ?? 0) + 1;
      c[i.kind] = (c[i.kind] ?? 0) + 1;
    }
    return c;
  }, [ideas]);

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            Video ideas
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            A running list of recordable concepts grounded in your top
            performers, your niche, competitors, and the calendar. Each card
            has an expiry — trends die, patterns stay. Refresh tops up to your
            target count.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-neutral-500">
            Target
            <select
              value={target}
              onChange={(e) => updateTarget(Number(e.target.value))}
              disabled={savingTarget}
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
            disabled={refreshing}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            {refreshing ? "Generating…" : "↻ Refresh"}
          </button>
        </div>
      </header>

      {!tiktokConnected && (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          TikTok is not connected.{" "}
          <Link href="/integrations" className="underline">
            Connect it
          </Link>{" "}
          to start generating ideas.
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

      <div className="mt-6 flex flex-wrap gap-2">
        {(["all", "pattern", "trend", "competitor", "seasonal"] as KindFilter[]).map((k) => {
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
              {label} <span className="ml-1 opacity-60">{counts[k] ?? 0}</span>
            </button>
          );
        })}
      </div>

      <section className="mt-6 space-y-3">
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {ideas.filter((i) => i.status === "pending").length === 0
              ? "No ideas yet. Hit Refresh to generate the first batch."
              : "No ideas match this filter."}
          </div>
        )}

        {filtered.map((i) => (
          <article
            key={i.id}
            className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${KIND_COLORS[i.kind]}`}
              >
                {KIND_LABELS[i.kind]}
              </span>
              <span
                className={`text-xs ${
                  isUrgent(i.expires_at)
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-neutral-500"
                }`}
              >
                {expiresLabel(i.expires_at)}
              </span>
            </div>
            <h3 className="mt-2 text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {i.title}
            </h3>
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
            <SourceRefs refs={i.source_refs} />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setStatus(i.id, "scheduled")}
                className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Mark scheduled
              </button>
              <button
                type="button"
                onClick={() => setStatus(i.id, "done")}
                className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                Done
              </button>
              <button
                type="button"
                onClick={() => remove(i.id)}
                className="rounded-md px-2.5 py-1 text-xs text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Dismiss
              </button>
            </div>
          </article>
        ))}
      </section>
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
