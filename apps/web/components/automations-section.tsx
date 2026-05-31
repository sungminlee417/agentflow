"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AutomationRow = {
  id: string;
  type: string;
  config: { repo?: string } & Record<string, unknown>;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
};

export type AutomationRunRow = {
  id: string;
  automation_id: string;
  issue_number: number;
  status: "running" | "done" | "failed";
  pr_url: string | null;
  pr_number: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type RunReport = {
  automation_id: string;
  repo?: string;
  status: "ok" | "skipped" | "failed";
  message: string;
  issue_number?: number;
  pr_url?: string;
};

export function AutomationsSection({
  automations,
  runs,
  githubConnected,
}: {
  automations: AutomationRow[];
  runs: AutomationRunRow[];
  githubConnected: boolean;
}) {
  const router = useRouter();
  const [repo, setRepo] = useState("");
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [reports, setReports] = useState<RunReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addAutomation(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    const res = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github_issue_to_pr",
        config: { repo: repo.trim() },
      }),
    });
    setAdding(false);
    if (!res.ok) {
      setError((await res.text()) || "Failed to add automation");
      return;
    }
    setRepo("");
    router.refresh();
  }

  async function toggleAutomation(id: string, enabled: boolean) {
    const res = await fetch("/api/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, enabled }),
    });
    if (res.ok) router.refresh();
  }

  async function deleteAutomation(id: string) {
    if (!confirm("Delete this automation? Run history is also deleted.")) return;
    const res = await fetch(`/api/automations?id=${id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  async function deleteRun(id: string, status: AutomationRunRow["status"]) {
    const confirmMsg =
      status === "running"
        ? "This run still shows as running. Delete it anyway? Usually fine for stuck runs."
        : "Delete this run? The next worker tick will retry the issue.";
    if (!confirm(confirmMsg)) return;
    const res = await fetch(`/api/automation-runs?id=${id}`, {
      method: "DELETE",
    });
    if (res.ok) router.refresh();
  }

  async function runNow() {
    setRunning(true);
    setError(null);
    setReports(null);
    const res = await fetch("/api/automations/run", { method: "POST" });
    setRunning(false);
    if (!res.ok) {
      setError((await res.text()) || "Run failed");
      return;
    }
    const data = (await res.json()) as { reports: RunReport[] };
    setReports(data.reports);
    router.refresh();
  }

  return (
    <section className="mt-12">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
            Automations
          </h2>
          <p className="mt-1 text-sm text-neutral-500">
            Standing instructions for the agent. Each click of "Run now"
            processes the oldest unhandled issue per automation.
          </p>
        </div>
        <button
          onClick={runNow}
          disabled={
            running || automations.length === 0 || !githubConnected
          }
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {running ? "Running…" : "Run now"}
        </button>
      </div>

      {!githubConnected && (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
          Connect GitHub above to enable automations.
        </div>
      )}

      <form
        onSubmit={addAutomation}
        className="mt-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Watch a repo for new issues
        </h3>
        <p className="mt-0.5 text-xs text-neutral-500">
          The agent reads each new issue, decides on a fix, and opens a PR
          (or comments for clarification if the issue is unclear).
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            placeholder="owner/repo"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            required
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          />
          <button
            type="submit"
            disabled={adding || repo.trim().length === 0}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            {adding ? "Adding…" : "Add"}
          </button>
        </div>
      </form>

      {automations.length > 0 && (
        <ul className="mt-4 space-y-2">
          {automations.map((a) => (
            <li
              key={a.id}
              className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <code className="font-mono text-sm text-neutral-900 dark:text-neutral-100">
                    {a.config.repo ?? "(missing repo)"}
                  </code>
                  <p className="mt-0.5 text-xs text-neutral-500">
                    Watch for new issues · {a.enabled ? "enabled" : "disabled"}
                    {a.last_run_at &&
                      ` · last ran ${new Date(a.last_run_at).toLocaleString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <button
                    onClick={() => toggleAutomation(a.id, !a.enabled)}
                    className="text-neutral-500 transition hover:text-neutral-900 dark:hover:text-neutral-100"
                  >
                    {a.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    onClick={() => deleteAutomation(a.id)}
                    className="text-neutral-500 transition hover:text-red-500 dark:hover:text-red-400"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {runs.filter((r) => r.automation_id === a.id).length > 0 && (
                <details className="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                  <summary className="cursor-pointer text-xs text-neutral-500">
                    Recent runs (
                    {runs.filter((r) => r.automation_id === a.id).length})
                  </summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {runs
                      .filter((r) => r.automation_id === a.id)
                      .slice(0, 10)
                      .map((r) => (
                        <li
                          key={r.id}
                          className="flex items-center justify-between gap-2 text-neutral-600 dark:text-neutral-400"
                        >
                          <span>
                            #{r.issue_number} ·{" "}
                            <span
                              className={
                                r.status === "done"
                                  ? "text-emerald-600 dark:text-emerald-400"
                                  : r.status === "failed"
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-neutral-500"
                              }
                            >
                              {r.status}
                            </span>
                            {r.error && ` · ${r.error.slice(0, 80)}`}
                          </span>
                          <span className="flex items-center gap-2">
                            {r.pr_url && (
                              <a
                                href={r.pr_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline dark:text-blue-400"
                              >
                                PR #{r.pr_number}
                              </a>
                            )}
                            <button
                              type="button"
                              onClick={() => deleteRun(r.id, r.status)}
                              className="text-neutral-400 transition hover:text-red-500 dark:hover:text-red-400"
                              title="Delete this run (next tick will retry the issue)"
                            >
                              Delete
                            </button>
                          </span>
                        </li>
                      ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {reports && reports.length > 0 && (
        <div className="mt-4 rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs dark:border-neutral-800 dark:bg-neutral-900">
          <p className="font-medium text-neutral-700 dark:text-neutral-300">
            Last run:
          </p>
          <ul className="mt-2 space-y-1">
            {reports.map((r, i) => (
              <li
                key={i}
                className={
                  r.status === "ok"
                    ? "text-emerald-600 dark:text-emerald-400"
                    : r.status === "failed"
                      ? "text-red-600 dark:text-red-400"
                      : "text-neutral-500"
                }
              >
                {r.repo ? `${r.repo}: ` : ""}
                {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
    </section>
  );
}
