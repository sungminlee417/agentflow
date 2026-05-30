"use client";

import { useState } from "react";

type Status = "running" | "done" | "error";

function StatusIcon({ status }: { status: Status }) {
  if (status === "running") {
    return (
      <span
        aria-hidden
        className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 dark:border-neutral-700 dark:border-t-neutral-300"
      />
    );
  }
  if (status === "done") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="h-3 w-3 text-emerald-600 dark:text-emerald-400"
        fill="currentColor"
      >
        <path d="M13.78 4.22a.75.75 0 010 1.06l-7 7a.75.75 0 01-1.06 0L2.22 8.78a.75.75 0 011.06-1.06L6.25 10.69l6.47-6.47a.75.75 0 011.06 0z" />
      </svg>
    );
  }
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className="h-3 w-3 text-red-600 dark:text-red-400"
      fill="currentColor"
    >
      <path d="M8 1a7 7 0 100 14 7 7 0 000-14zm.75 3.5v4.5h-1.5V4.5h1.5zm0 6v1.5h-1.5V10.5h1.5z" />
    </svg>
  );
}

function formatPayload(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function summarize(name: string, output: unknown): string {
  // Try to render a one-line hint for the result. Fall back to JSON shape.
  if (output === null || output === undefined) return "";
  if (typeof output === "string") {
    const trimmed = output.trim().replace(/\s+/g, " ");
    return trimmed.length > 80 ? trimmed.slice(0, 77) + "…" : trimmed;
  }
  if (Array.isArray(output)) {
    return `${output.length} item${output.length === 1 ? "" : "s"}`;
  }
  if (typeof output === "object") {
    if ("url" in (output as object) && typeof (output as { url: unknown }).url === "string") {
      return (output as { url: string }).url;
    }
    const keys = Object.keys(output as object);
    return `{ ${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""} }`;
  }
  return String(output);
}

export function ToolStep({
  name,
  input,
  output,
  status,
}: {
  name: string;
  input: unknown;
  output: unknown;
  status: Status;
}) {
  const [open, setOpen] = useState(false);
  const summary =
    status === "done" ? summarize(name, output) : status === "running" ? "running…" : "error";

  return (
    <div className="my-2 overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 text-xs dark:border-neutral-800 dark:bg-neutral-900/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-100 dark:hover:bg-neutral-800/40"
      >
        <StatusIcon status={status} />
        <code className="font-mono font-medium text-neutral-900 dark:text-neutral-100">
          {name}
        </code>
        <span className="flex-1 truncate text-neutral-500 dark:text-neutral-400">
          {summary}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className={`h-3 w-3 text-neutral-400 transition-transform ${open ? "rotate-90" : ""}`}
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4z" />
        </svg>
      </button>

      {open && (
        <div className="space-y-2 border-t border-neutral-200 px-3 py-2 dark:border-neutral-800">
          <div>
            <div className="mb-1 text-[10px] tracking-wide text-neutral-500 uppercase">
              Input
            </div>
            <pre className="max-h-60 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
              {formatPayload(input)}
            </pre>
          </div>
          {status !== "running" && (
            <div>
              <div className="mb-1 text-[10px] tracking-wide text-neutral-500 uppercase">
                {status === "error" ? "Error" : "Output"}
              </div>
              <pre className="max-h-60 overflow-auto rounded bg-white p-2 text-[11px] leading-relaxed text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300">
                {formatPayload(output)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
