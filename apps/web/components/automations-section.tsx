"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AUTOMATION_TYPES,
  SCHEDULE_OPTIONS,
  isSocialBrief,
  getAutomationTypeMeta,
  type AutomationKind,
  type AutomationSchedule,
  type AutomationTypeMeta,
} from "@agentflow/core";
import { Markdown } from "@/components/markdown";
import { useConfirm } from "@/components/confirm-dialog";

export type AutomationRow = {
  id: string;
  type: string;
  config: { repo?: string; focus?: string } & Record<string, unknown>;
  enabled: boolean;
  schedule: AutomationSchedule;
  last_run_at: string | null;
  created_at: string;
};

export type AutomationRunRow = {
  id: string;
  automation_id: string;
  issue_number: number | null;
  status: "running" | "done" | "failed";
  pr_url: string | null;
  pr_number: number | null;
  error: string | null;
  report_markdown?: string | null;
  started_at: string;
  finished_at: string | null;
};

type RunReport = {
  automation_id: string;
  status: "ok" | "skipped" | "failed";
  message: string;
  meta?: Record<string, unknown>;
};

export function AutomationsSection({
  automations,
  runs,
  availableTypes,
  connectedProviders,
}: {
  automations: AutomationRow[];
  runs: AutomationRunRow[];
  /** Which automation types this manager's UI should expose */
  availableTypes: AutomationKind[];
  /** What providers the user has connected (drives the "requires X" check) */
  connectedProviders: string[];
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [selectedType, setSelectedType] = useState<AutomationKind>(
    availableTypes[0] ?? "github_issue_to_pr",
  );
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<AutomationSchedule>("manual");
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [reports, setReports] = useState<RunReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const typeOptions = useMemo(
    () =>
      AUTOMATION_TYPES.filter((t) =>
        availableTypes.includes(t.type),
      ) as AutomationTypeMeta[],
    [availableTypes],
  );
  const selectedMeta = useMemo(
    () => getAutomationTypeMeta(selectedType),
    [selectedType],
  );

  // Whenever the selected type changes, reset schedule + config.
  function pickType(t: AutomationKind) {
    setSelectedType(t);
    const meta = getAutomationTypeMeta(t);
    setSchedule(meta?.defaultSchedule ?? "manual");
    setConfigValues({});
  }

  function setConfigField(name: string, value: string) {
    setConfigValues((prev) => ({ ...prev, [name]: value }));
  }

  const canSubmit = (() => {
    if (!selectedMeta) return false;
    for (const f of selectedMeta.configFields) {
      const required = f.name === "repo"; // only repo is currently required
      const v = configValues[f.name]?.trim() ?? "";
      if (required && v.length === 0) return false;
    }
    for (const req of selectedMeta.requires) {
      if (!connectedProviders.includes(req)) return false;
    }
    return true;
  })();

  async function addAutomation(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    const config: Record<string, string> = {};
    for (const f of selectedMeta?.configFields ?? []) {
      const v = configValues[f.name]?.trim();
      if (v) config[f.name] = v;
    }
    const res = await fetch("/api/automations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: selectedType, schedule, config }),
    });
    setAdding(false);
    if (!res.ok) {
      setError((await res.text()) || "Failed to add automation");
      return;
    }
    setConfigValues({});
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

  async function updateSchedule(id: string, newSchedule: AutomationSchedule) {
    const res = await fetch("/api/automations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, schedule: newSchedule }),
    });
    if (res.ok) router.refresh();
  }

  async function deleteAutomation(id: string) {
    const ok = await confirm({
      title: "Delete this automation?",
      description: "Run history is also deleted.",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const res = await fetch(`/api/automations?id=${id}`, { method: "DELETE" });
    if (res.ok) router.refresh();
  }

  async function deleteRun(id: string, status: AutomationRunRow["status"]) {
    const description =
      status === "running"
        ? "This run still shows as running. Usually fine for stuck runs."
        : "The next worker tick will retry.";
    const ok = await confirm({
      title: "Delete this run?",
      description,
      confirmLabel: "Delete",
    });
    if (!ok) return;
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
            Standing instructions for the agent. Scheduled automations run
            automatically; "Run now" triggers all manually.
          </p>
        </div>
        <button
          onClick={runNow}
          disabled={running || automations.length === 0}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
        >
          {running ? "Running…" : "Run now"}
        </button>
      </div>

      <form
        onSubmit={addAutomation}
        className="mt-4 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
      >
        <label className="block text-xs text-neutral-500">Automation type</label>
        <select
          value={selectedType}
          onChange={(e) => pickType(e.target.value as AutomationKind)}
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
        >
          {typeOptions.map((t) => (
            <option key={t.type} value={t.type}>
              {t.label}
            </option>
          ))}
        </select>

        {selectedMeta && (
          <p className="mt-2 text-xs text-neutral-500">{selectedMeta.description}</p>
        )}

        {selectedMeta && selectedMeta.requires.length > 0 && (
          <p className="mt-1 text-[11px] text-neutral-500">
            Requires:{" "}
            {selectedMeta.requires.map((r) => (
              <span
                key={r}
                className={
                  connectedProviders.includes(r)
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400"
                }
              >
                {r}
                {connectedProviders.includes(r) ? "✓" : " (not connected)"}{" "}
              </span>
            ))}
          </p>
        )}

        {selectedMeta?.configFields.map((f) => (
          <div key={f.name} className="mt-3">
            <label className="block text-xs text-neutral-500">{f.label}</label>
            <input
              type="text"
              placeholder={f.placeholder}
              value={configValues[f.name] ?? ""}
              onChange={(e) => setConfigField(f.name, e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </div>
        ))}

        <div className="mt-3 flex items-center gap-3">
          <label className="text-xs text-neutral-500">Schedule</label>
          <select
            value={schedule}
            onChange={(e) =>
              setSchedule(e.target.value as AutomationSchedule)
            }
            className="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-900 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          >
            {SCHEDULE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={adding || !canSubmit}
            className="ml-auto rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-neutral-200"
          >
            {adding ? "Adding…" : "Add automation"}
          </button>
        </div>
      </form>

      {automations.length > 0 && (
        <ul className="mt-4 space-y-2">
          {automations.map((a) => {
            const meta = getAutomationTypeMeta(a.type);
            const subtitle = a.config.repo ?? a.config.focus ?? "";
            return (
              <li
                key={a.id}
                className="rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
                      {meta?.label ?? a.type}
                    </div>
                    {subtitle && (
                      <div className="mt-0.5 truncate text-xs text-neutral-500">
                        {subtitle}
                      </div>
                    )}
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {a.enabled ? "enabled" : "disabled"}
                      {a.last_run_at &&
                        ` · last ran ${new Date(a.last_run_at).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
                    <select
                      value={a.schedule}
                      onChange={(e) =>
                        updateSchedule(
                          a.id,
                          e.target.value as AutomationSchedule,
                        )
                      }
                      className="rounded-md border border-neutral-300 bg-white px-2 py-0.5 text-[11px] text-neutral-700 focus:border-neutral-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                    >
                      {SCHEDULE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
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
                    <ul className="mt-2 space-y-2 text-xs">
                      {runs
                        .filter((r) => r.automation_id === a.id)
                        .slice(0, 10)
                        .map((r) => (
                          <RunRowView
                            key={r.id}
                            r={r}
                            isSocial={isSocialBrief(a.type)}
                            onDelete={deleteRun}
                          />
                        ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
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
                {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>
      )}
      {dialog}
    </section>
  );
}

function RunRowView({
  r,
  isSocial,
  onDelete,
}: {
  r: AutomationRunRow;
  isSocial: boolean;
  onDelete: (id: string, status: AutomationRunRow["status"]) => void;
}) {
  return (
    <li className="rounded-md border border-neutral-100 p-2 text-neutral-600 dark:border-neutral-800/60 dark:text-neutral-400">
      <div className="flex items-center justify-between gap-2">
        <span>
          {isSocial
            ? new Date(r.started_at).toLocaleString()
            : `#${r.issue_number ?? "?"}`}{" "}
          ·{" "}
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
            onClick={() => onDelete(r.id, r.status)}
            className="text-neutral-400 transition hover:text-red-500 dark:hover:text-red-400"
            title="Delete this run"
          >
            Delete
          </button>
        </span>
      </div>

      {isSocial && r.report_markdown && (
        <details className="mt-2 rounded border border-neutral-200 bg-white p-2 dark:border-neutral-800 dark:bg-neutral-950">
          <summary className="cursor-pointer text-[11px] text-neutral-500">
            View brief ({Math.round(r.report_markdown.length / 1024)}KB)
          </summary>
          <div className="mt-2 max-h-[60vh] overflow-auto text-[13px] text-neutral-900 dark:text-neutral-100">
            <Markdown>{r.report_markdown}</Markdown>
          </div>
        </details>
      )}
    </li>
  );
}
