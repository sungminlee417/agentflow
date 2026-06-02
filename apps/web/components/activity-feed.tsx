"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { managerForAutomationType } from "@agentflow/core";
import { useConfirm } from "@/components/confirm-dialog";

export type RunRow = {
  id: string;
  automation_id: string;
  issue_number: number | null;
  status: "running" | "done" | "failed";
  pr_url: string | null;
  pr_number: number | null;
  error: string | null;
  summary: string | null;
  tokens: number | null;
  step_count: number;
  last_step: string | null;
  started_at: string;
  finished_at: string | null;
};

export type AutomationSummary = {
  id: string;
  type: string;
  config: { repo?: string } & Record<string, unknown>;
};

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatDuration(startedAt: string, finishedAt: string | null): string {
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const ms = end - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function StatusBadge({ status }: { status: RunRow["status"] }) {
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-950/40 dark:text-blue-300">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
        Running
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        Done
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
      Failed
    </span>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
        {value}
      </div>
      {hint && (
        <div className="mt-0.5 text-xs text-neutral-500">{hint}</div>
      )}
    </div>
  );
}

export function ActivityFeed({
  initialRuns,
  automations,
}: {
  initialRuns: RunRow[];
  automations: AutomationSummary[];
}) {
  const [runs, setRuns] = useState<RunRow[]>(initialRuns);
  const { confirm, dialog } = useConfirm();
  // Tick once a second so "Running 23s" / "5m ago" labels stay fresh.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase
      .channel("automation_runs_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "automation_runs" },
        (payload) => {
          setRuns((prev) => [payload.new as RunRow, ...prev].slice(0, 100));
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "automation_runs" },
        (payload) => {
          const updated = payload.new as RunRow;
          setRuns((prev) =>
            prev.map((r) => (r.id === updated.id ? updated : r)),
          );
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "automation_runs" },
        (payload) => {
          const removedId = (payload.old as { id?: string } | null)?.id;
          if (!removedId) return;
          setRuns((prev) => prev.filter((r) => r.id !== removedId));
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  async function deleteRun(id: string, status: RunRow["status"]) {
    const description =
      status === "running"
        ? "This run still shows as running. If the worker is genuinely still working, its update will silently fail — usually fine for stuck runs."
        : "The next worker tick will retry the underlying issue.";
    const ok = await confirm({
      title: "Delete this run?",
      description,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    // Optimistic remove; Realtime DELETE event will also fire.
    setRuns((prev) => prev.filter((r) => r.id !== id));
    const res = await fetch(`/api/automation-runs?id=${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      console.error("delete run failed:", await res.text());
    }
  }

  const automationsById = useMemo(
    () => new Map(automations.map((a) => [a.id, a])),
    [automations],
  );

  const stats = useMemo(() => {
    const total = runs.length;
    const done = runs.filter((r) => r.status === "done").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const running = runs.filter((r) => r.status === "running").length;
    const completed = done + failed;
    const successRate =
      completed > 0 ? Math.round((done / completed) * 100) : null;
    const prs = runs.filter((r) => r.pr_url).length;
    return { total, done, failed, running, successRate, prs };
  }, [runs]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:px-6">
      {/* Left-pad title on mobile to clear the hamburger button */}
      <div className="flex flex-wrap items-baseline justify-between gap-y-1 pl-10 md:pl-0">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-100">
          Activity
        </h1>
        <span className="text-xs text-neutral-500">
          Last 100 runs · live
        </span>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Active now" value={stats.running} />
        <StatCard
          label="Success rate"
          value={stats.successRate === null ? "—" : `${stats.successRate}%`}
          hint={`${stats.done} done · ${stats.failed} failed`}
        />
        <StatCard label="PRs opened" value={stats.prs} />
        <StatCard label="Total runs" value={stats.total} />
      </div>

      <div className="mt-8">
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-300 px-6 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700">
            No runs yet. Open a Manager from the sidebar, add an automation,
            and runs will appear here in real time.
          </div>
        ) : (
          <ul className="space-y-2">
            {runs.map((r) => {
              const automation = automationsById.get(r.automation_id);
              const duration = formatDuration(r.started_at, r.finished_at);
              const manager = automation
                ? managerForAutomationType(automation.type)
                : undefined;
              const rawSubtitle =
                automation?.config?.repo ?? "(deleted automation)";
              const subtitle =
                typeof rawSubtitle === "string" ? rawSubtitle : "";
              return (
                <li
                  key={r.id}
                  className="rounded-lg border border-neutral-200 bg-white p-4 transition dark:border-neutral-800 dark:bg-neutral-950"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <StatusBadge status={r.status} />
                    {manager && (
                      <Link
                        href={`/managers/${manager.slug}`}
                        className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700 transition hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700"
                      >
                        {manager.label}
                      </Link>
                    )}
                    {subtitle && (
                      <code className="font-mono text-sm text-neutral-900 dark:text-neutral-100">
                        {subtitle}
                      </code>
                    )}
                    {r.issue_number !== null && (
                      <span className="text-sm text-neutral-500">
                        issue #{r.issue_number}
                      </span>
                    )}
                    {r.pr_url && (
                      <a
                        href={r.pr_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 hover:underline dark:text-blue-400"
                      >
                        → PR #{r.pr_number}
                      </a>
                    )}
                    <span className="ml-auto text-xs text-neutral-500">
                      {formatRelative(r.started_at)} · {duration}
                    </span>
                    <button
                      type="button"
                      onClick={() => deleteRun(r.id, r.status)}
                      className="text-xs text-neutral-400 transition hover:text-red-500 dark:hover:text-red-400"
                      title="Delete this run"
                    >
                      Delete
                    </button>
                  </div>

                  {r.status === "running" && r.last_step && (
                    <div className="mt-2 flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
                      <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
                      <span className="text-neutral-500">
                        step {r.step_count}:
                      </span>
                      <span>{r.last_step}</span>
                    </div>
                  )}

                  {r.status === "failed" && r.error && (
                    <details className="mt-2 text-xs">
                      <summary className="cursor-pointer text-neutral-500">
                        Error
                      </summary>
                      <pre className="mt-1 max-h-60 overflow-auto rounded bg-neutral-50 p-2 text-[11px] leading-relaxed text-red-700 dark:bg-neutral-900 dark:text-red-300">
                        {r.error}
                      </pre>
                    </details>
                  )}

                  {r.status === "done" && r.summary && !r.pr_url && (
                    <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
                      {r.summary.slice(0, 200)}
                      {r.summary.length > 200 ? "…" : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {dialog}
    </div>
  );
}
