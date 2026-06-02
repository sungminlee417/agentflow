"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Modal } from "@/components/modal";

export type VideoIdeaRow = {
  id: string;
  provider: string;
  integration_id: string | null;
  title: string;
  hook: string | null;
  format: string | null;
  rationale: string | null;
  kind: "pattern" | "trend" | "competitor" | "seasonal";
  source_refs: Record<string, unknown> | null;
  expires_at: string;
  status: "pending" | "scheduled" | "done" | "dismissed";
  created_at: string;
  script: string | null;
  post_title: string | null;
  description: string | null;
  hashtags: string[] | null;
  cta: string | null;
  visual_notes: string | null;
};

export type IdeasAccount = {
  id: string;
  provider: string;
  handle: string | null;
  displayName: string | null;
  accountLabel: string | null;
  providerAccountId: string;
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
}: {
  accounts: IdeasAccount[];
  selectedAccountId: string | null;
  initial: VideoIdeaRow[];
  targetCount: number;
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
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState<{
    count: number;
    label: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [savingTarget, setSavingTarget] = useState(false);
  const [detailIdeaId, setDetailIdeaId] = useState<string | null>(null);
  const detailIdea = useMemo(
    () => ideas.find((i) => i.id === detailIdeaId) ?? null,
    [ideas, detailIdeaId],
  );

  const filtered = useMemo(() => {
    const list = ideas.filter((i) => i.status === "pending");
    if (filter === "all") return list;
    return list.filter((i) => i.kind === filter);
  }, [ideas, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: 0,
      pattern: 0,
      trend: 0,
      competitor: 0,
      seasonal: 0,
    };
    for (const i of ideas) {
      if (i.status !== "pending") continue;
      c["all"] = (c["all"] ?? 0) + 1;
      c[i.kind] = (c[i.kind] ?? 0) + 1;
    }
    return c;
  }, [ideas]);

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
    try {
      const res = await fetch("/api/video-ideas/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ integration_id: selectedAccountId }),
      });
      if (!res.ok || !res.body) {
        setError(`Refresh failed (${res.status}).`);
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
          if (evtType === "prepare") {
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
            setError(
              typeof payload.error === "string"
                ? payload.error
                : "Refresh failed.",
            );
            return;
          }
        }
      }

      if (finalMessage) setMessage(finalMessage);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      setProgress(null);
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

  return (
    <div className="mx-auto max-w-3xl px-6 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
            Video ideas
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            One running list per connected account. Each card has an
            expiry — trends die, patterns stay. Refresh tops up to your target
            count.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-neutral-500">
            Target
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
            className="inline-flex items-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 transition hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            {refreshing && (
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700 dark:border-neutral-700 dark:border-t-neutral-200" />
            )}
            {refreshing ? "Generating…" : "↻ Refresh"}
          </button>
        </div>
      </header>

      {refreshing && progress && (
        <div className="mt-6 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/30">
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-blue-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
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
                Generation usually takes 30-60 seconds. You can leave this
                tab — the run continues server-side.
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500">Account:</span>
        <select
          value={selectedAccountId ?? ""}
          onChange={(e) => switchAccount(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
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
          + Add another account
        </Link>
      </div>

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
        {(["all", "pattern", "trend", "competitor", "seasonal"] as KindFilter[]).map(
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

      <section className="mt-6 space-y-3">
        {filtered.length === 0 && (
          <div className="rounded-lg border border-dashed border-neutral-300 px-4 py-10 text-center text-sm text-neutral-500 dark:border-neutral-700">
            {ideas.filter((i) => i.status === "pending").length === 0
              ? "No ideas yet for this account. Hit Refresh to generate the first batch."
              : "No ideas match this filter."}
          </div>
        )}

        {filtered.map((i) => {
          const hasFullContent =
            !!i.script || !!i.description || (i.hashtags?.length ?? 0) > 0;
          return (
            <article
              key={i.id}
              className="group rounded-lg border border-neutral-200 bg-white p-4 transition hover:border-neutral-300 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-700"
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
                <p className="mt-1 text-xs text-neutral-500">
                  Format: {i.format}
                </p>
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
                  onClick={() => setDetailIdeaId(i.id)}
                  className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
                >
                  View details →
                </button>
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
          );
        })}
      </section>

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

        {idea.source_refs && Object.keys(idea.source_refs).length > 0 && (
          <Section title="Source evidence">
            <div className="text-[11px]">
              <SourceRefs refs={idea.source_refs} />
            </div>
          </Section>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <button
            type="button"
            onClick={onSchedule}
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            Mark scheduled
          </button>
          <button
            type="button"
            onClick={onDone}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-neutral-700 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            Mark done
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
